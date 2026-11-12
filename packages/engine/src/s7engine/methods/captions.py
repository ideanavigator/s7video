# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`captions.render`: the edit's caption chunks as transparent PNG stills, for the player (S7V-075).

The chunks are the export's own (`export.export_chunks`): the caption items, or with none, the
clips' transcripts, exactly as the export burns them in, in the edit's look (S7V-037). Each still
is one of the export's ASS events (`captions_ass.cues`: a chunk, or for a look that lights the
word being said, one word state), drawn by the same ASS builder and libass onto a transparent
canvas of the edit's size, so the player shows what the export shows.

Stills are cached in ``cacheDir/<look>/<cue>.png``. ``look`` hashes everything the pixels depend
on besides the cue: canvas size, the look's style file, the bundled fonts and `RENDER_VERSION`;
``cue`` hashes the text and the lit word. Timing never changes a still, so a cut or trim draws only
the cues it makes new. All missing cues are drawn in one FFmpeg run, retimed to one per second.

`captions.preview` draws a look's sample caption on a flat synthetic frame with the same builder,
cut to the caption band, for the Editor's look picker; it is cached in that look's folder.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

from .. import captions_ass, timebase
from ..edit_schema import validate_edit_document
from ..ffmpeg import QUICK_TOOL_TIMEOUT, run_tool
from ..jobs import JobContext
from ..rpc import INVALID_PARAMS, OUTPUT_ERROR, Method, RpcError
from . import export
from ._media import PATH_SCHEMA

#: Bump when the drawing changes in a way the hashed inputs don't show: the ASS builder's code,
#: the FFmpeg arguments below. Style files and fonts are hashed, so editing them needs no bump.
#: 2: looks other than s7-neutral, and one still per word state (S7V-037).
RENDER_VERSION = 2
#: Looks kept per project (one per canvas size and style); the oldest are removed.
KEEP_LOOKS = 4
#: Stills kept per look, newest used first: thousands of chunks, a few dozen MB.
KEEP_STILLS = 4000
#: A temp folder this old was left by a killed engine.
STALE_TEMP_SECONDS = 3600
#: FFmpeg's time per still on an M4 Max is ~4 ms; this leaves room for an 8 GB M1 Air.
SECONDS_PER_STILL = 0.1
#: The previews' sample caption: three short words fit one line in every look and shape.
PREVIEW_WORDS = ("Say", "it", "loud")
#: The word a highlighting look lights in its preview.
PREVIEW_LIT = 1
#: A flat slate frame: the white text, its shadow and the dark box all read on it.
PREVIEW_BACKGROUND = "0x5B6270"
PREVIEW_WIDTH = 240


def timeline_end(edit: dict[str, Any]) -> int:
    """The last frame the export plays: the end of the first video track's last item."""
    video = next((track for track in edit["tracks"] if track["kind"] == "video"), None)
    return max((item["start"] + item["duration"] for item in (video or {}).get("items", [])), default=0)


def chunks_of(edit: dict[str, Any], transcripts: list[dict[str, Any]] | None = None) -> list[captions_ass.Chunk]:
    """The chunks the export burns in: the caption items, or with none, the transcripts'."""
    rate = timebase.from_rational(edit["fps"])
    try:
        plan = export.plan_segments(edit, int(edit["canvas"]["width"]), int(edit["canvas"]["height"]))
    except RpcError:
        # An edit the export cannot draw yet still previews its caption items.
        if not export.has_caption_items(edit):
            return []
        style = export.caption_style(edit)
        return captions_ass.caption_chunks(export.caption_items(edit), rate, timeline_end(edit), style)
    return export.export_chunks(edit, plan, {"transcripts": transcripts or []})


def _digest(*parts: bytes) -> str:
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(len(part).to_bytes(8, "big"))
        hasher.update(part)
    return hasher.hexdigest()


def look_key(width: int, height: int, style_id: str = captions_ass.DEFAULT_STYLE) -> str:
    """Everything a still's pixels depend on besides its cue."""
    style = (captions_ass.STYLES_DIR / f"{style_id}.json").read_bytes()
    fonts = [
        font.name.encode() + font.read_bytes()
        for font in sorted(captions_ass.FONTS_DIR.iterdir())
        if font.suffix.lower() in (".ttf", ".otf")
    ]
    header = json.dumps({"render": RENDER_VERSION, "width": width, "height": height, "style": style_id}).encode()
    return _digest(header, style, *fonts)[:32]


def _still_name(cue: captions_ass.Cue) -> str:
    """The cue's words and lit word: everything but the timing, which never changes a still."""
    key = json.dumps({"words": cue.words, "lit": cue.lit}, ensure_ascii=False).encode("utf-8")
    return f"{_digest(key)[:32]}.png"


def _render(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    edit = params["edit"]
    issues = validate_edit_document(edit)
    if issues:
        raise RpcError(INVALID_PARAMS, f"the edit is not valid: {issues[0].explanation}")
    cache_dir = Path(params["cacheDir"])
    if not cache_dir.is_absolute():
        raise RpcError(INVALID_PARAMS, "invalid params at cacheDir: must be absolute")
    width, height = int(edit["canvas"]["width"]), int(edit["canvas"]["height"])
    style_id = export.caption_style(edit)
    cues = captions_ass.cues(chunks_of(edit, params.get("transcripts")), style_id)
    look = look_key(width, height, style_id)
    folder = cache_dir / look
    # One still per distinct cue; retimed, a cue keeps only what it draws.
    shapes = {_still_name(cue): captions_ass.Cue(cue.words, 0, 1, cue.lit) for cue in cues}
    missing = [name for name in shapes if not (folder / name).is_file()]
    if missing:
        export._require(export.capabilities(job).libass, "libass", "to draw captions")
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise RpcError(OUTPUT_ERROR, "the captions folder cannot be created") from None
        _draw([(name, shapes[name]) for name in missing], style_id, width, height, cache_dir, folder, job)
    now = time.time()
    for name in shapes:
        # Marks the still as used, so pruning keeps it.
        os.utime(folder / name, (now, now))
    _prune(cache_dir, look)
    return {
        "width": width,
        "height": height,
        "folder": look,
        "drawn": len(missing),
        "chunks": [{"start": cue.start, "end": cue.end, "png": _still_name(cue)} for cue in cues],
    }


def _draw(
    stills: list[tuple[str, captions_ass.Cue]],
    style_id: str,
    width: int,
    height: int,
    cache_dir: Path,
    folder: Path,
    job: JobContext,
) -> None:
    # Inside the cache, so finished stills move into place on the same volume; removed on any exit.
    try:
        workdir = Path(tempfile.mkdtemp(prefix=".tmp-", dir=cache_dir))
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the captions folder cannot be written") from None
    try:
        timed = [captions_ass.Cue(cue.words, number, number + 1, cue.lit) for number, (_, cue) in enumerate(stills)]
        captions_ass.write_cues(workdir / "captions.ass", timed, Fraction(1), width, height, style_id)
        captions_ass.link_fonts(workdir / "fonts")
        source = f"color=c=black@0:s={width}x{height}:r=1:d={len(stills)},format=rgba"
        run_tool(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                source,
                "-vf",
                # Relative names, as the export: a temp path could hold filter syntax.
                "subtitles=filename=captions.ass:fontsdir=fonts:alpha=1",
                "-start_number",
                "0",
                "-f",
                "image2",
                "-y",
                "still-%05d.png",
            ],
            job,
            timeout=max(QUICK_TOOL_TIMEOUT, SECONDS_PER_STILL * len(stills)),
            cwd=str(workdir),
        )
        for number, (name, _) in enumerate(stills):
            still = workdir / f"still-{number:05d}.png"
            if not still.exists():
                raise RpcError(OUTPUT_ERROR, "ffmpeg did not draw every caption")
            os.replace(still, folder / name)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def preview_band(width: int, height: int, style_id: str) -> tuple[int, int, int, int]:
    """What a preview shows, as (left, top, right, bottom): the sample line and its edges, sized by
    the font, so every canvas shape gives the strip the same text size."""
    layout = captions_ass.layout_for(width, height, captions_ass.load_style(style_id))
    bottom = min(height, height - layout.margin_bottom + math.ceil(layout.edge + layout.shadow) + layout.font_size // 2)
    top = max(0, bottom - round(2.2 * layout.font_size))
    span = min(width, 10 * layout.font_size)
    middle = (layout.margin_left + width - layout.margin_right) // 2
    left = min(max(0, middle - span // 2), width - span)
    return (left - left % 2, top - top % 2, left - left % 2 + span - span % 2, bottom - bottom % 2)


def preview_cue(style_id: str) -> captions_ass.Cue:
    lit = PREVIEW_LIT if "highlight" in captions_ass.load_style(style_id) else None
    return captions_ass.Cue(PREVIEW_WORDS, 0, 1, lit)


def _preview(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    style_id = export._checked_style(params["preset"])
    width, height = int(params["width"]), int(params["height"])
    if width % 2 or height % 2:
        raise RpcError(INVALID_PARAMS, "invalid params at width: width and height must be even")
    cache_dir = Path(params["cacheDir"])
    if not cache_dir.is_absolute():
        raise RpcError(INVALID_PARAMS, "invalid params at cacheDir: must be absolute")
    look = look_key(width, height, style_id)
    folder = cache_dir / look
    sample = json.dumps([PREVIEW_WORDS, PREVIEW_BACKGROUND, PREVIEW_WIDTH]).encode()
    name = f"preview-{_digest(sample)[:16]}.png"
    if not (folder / name).is_file():
        export._require(export.capabilities(job).libass, "libass", "to draw captions")
        try:
            folder.mkdir(parents=True, exist_ok=True)
            workdir = Path(tempfile.mkdtemp(prefix=".tmp-", dir=cache_dir))
        except OSError:
            raise RpcError(OUTPUT_ERROR, "the captions folder cannot be written") from None
        try:
            captions_ass.write_cues(workdir / "preview.ass", [preview_cue(style_id)], Fraction(1), width, height, style_id)
            captions_ass.link_fonts(workdir / "fonts")
            left, top, right, bottom = preview_band(width, height, style_id)
            run_tool(
                "ffmpeg",
                [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    f"color=c={PREVIEW_BACKGROUND}:s={width}x{height}:r=1:d=1,format=yuv420p",
                    "-vf",
                    # As the export burns captions: onto 4:2:0 frames, then cut and shrunk for the strip.
                    f"subtitles=filename=preview.ass:fontsdir=fonts,crop={right - left}:{bottom - top}:{left}:{top},"
                    f"scale={PREVIEW_WIDTH}:-2:flags=area,format=rgb24",
                    "-frames:v",
                    "1",
                    "-f",
                    "image2",
                    "-y",
                    "preview.png",
                ],
                job,
                timeout=QUICK_TOOL_TIMEOUT,
                cwd=str(workdir),
            )
            if not (workdir / "preview.png").exists():
                raise RpcError(OUTPUT_ERROR, "ffmpeg did not draw the preview")
            os.replace(workdir / "preview.png", folder / name)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    return {"folder": look, "png": name}


def _prune(cache_dir: Path, current: str) -> None:
    """Keeps the newest looks and stills; sweeps temp folders a killed engine left. Never fails."""
    try:
        entries = list(cache_dir.iterdir())
        now = time.time()
        for entry in entries:
            if entry.name.startswith(".tmp-") and now - entry.stat().st_mtime > STALE_TEMP_SECONDS:
                shutil.rmtree(entry, ignore_errors=True)
        looks = sorted(
            (entry for entry in entries if entry.is_dir() and not entry.name.startswith(".")),
            key=lambda entry: (entry.name == current, entry.stat().st_mtime),
            reverse=True,
        )
        for old in looks[KEEP_LOOKS:]:
            shutil.rmtree(old, ignore_errors=True)
        stills = sorted((cache_dir / current).glob("*.png"), key=lambda still: still.stat().st_mtime, reverse=True)
        for old in stills[KEEP_STILLS:]:
            old.unlink(missing_ok=True)
    except OSError:
        pass


_TRANSCRIPT_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "required": ["media", "fps", "words"],
        "properties": {
            "media": {"type": "string"},
            "fps": {"type": "object"},
            "words": {"type": "array"},
        },
    },
}

METHOD = Method(
    "captions.render",
    _render,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["edit", "cacheDir"],
        "properties": {
            "edit": {"type": "object"},
            "cacheDir": PATH_SCHEMA,
            # The clips' cached transcripts, used only when the edit has no caption items, as export.
            "transcripts": _TRANSCRIPT_SCHEMA,
        },
    },
)

PREVIEW_METHOD = Method(
    "captions.preview",
    _preview,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["preset", "width", "height", "cacheDir"],
        "properties": {
            "preset": {"type": "string"},
            "width": {"type": "integer", "minimum": 16, "maximum": 8192},
            "height": {"type": "integer", "minimum": 16, "maximum": 8192},
            "cacheDir": PATH_SCHEMA,
        },
    },
)
