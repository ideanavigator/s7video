# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`captions.render`: the edit's caption chunks as transparent PNG stills, for the player (S7V-075).

The chunks are the export's own (`export.export_chunks`): the caption items, or with none, the
clips' transcripts, exactly as the export burns them in. Each still is drawn by the same ASS
builder and libass onto a transparent canvas of the edit's size, so the player shows what the
export shows.

Stills are cached in ``cacheDir/<look>/<text>.png``. ``look`` hashes everything the pixels depend
on besides the text: canvas size, the style file's bytes, the bundled fonts and `RENDER_VERSION`;
``text`` hashes the chunk's text. Timing never changes a still, so a cut or trim draws only the
texts it makes new. All missing texts are drawn in one FFmpeg run, retimed to one per second.
"""

from __future__ import annotations

import hashlib
import json
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
RENDER_VERSION = 1
#: Looks kept per project (one per canvas size and style); the oldest are removed.
KEEP_LOOKS = 4
#: Stills kept per look, newest used first: thousands of chunks, a few dozen MB.
KEEP_STILLS = 4000
#: A temp folder this old was left by a killed engine.
STALE_TEMP_SECONDS = 3600
#: FFmpeg's time per still on an M4 Max is ~4 ms; this leaves room for an 8 GB M1 Air.
SECONDS_PER_STILL = 0.1


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
        return captions_ass.caption_chunks(export.caption_items(edit), rate, timeline_end(edit))
    return export.export_chunks(edit, plan, {"transcripts": transcripts or []})


def _digest(*parts: bytes) -> str:
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(len(part).to_bytes(8, "big"))
        hasher.update(part)
    return hasher.hexdigest()


def look_key(width: int, height: int) -> str:
    """Everything a still's pixels depend on besides its text."""
    style = (captions_ass.STYLES_DIR / f"{captions_ass.DEFAULT_STYLE}.json").read_bytes()
    fonts = [
        font.name.encode() + font.read_bytes()
        for font in sorted(captions_ass.FONTS_DIR.iterdir())
        if font.suffix.lower() in (".ttf", ".otf")
    ]
    header = json.dumps({"render": RENDER_VERSION, "width": width, "height": height}).encode()
    return _digest(header, style, *fonts)[:32]


def _still_name(text: str) -> str:
    return f"{_digest(text.encode('utf-8'))[:32]}.png"


def _render(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    edit = params["edit"]
    issues = validate_edit_document(edit)
    if issues:
        raise RpcError(INVALID_PARAMS, f"the edit is not valid: {issues[0].explanation}")
    cache_dir = Path(params["cacheDir"])
    if not cache_dir.is_absolute():
        raise RpcError(INVALID_PARAMS, "invalid params at cacheDir: must be absolute")
    width, height = int(edit["canvas"]["width"]), int(edit["canvas"]["height"])
    chunks = chunks_of(edit, params.get("transcripts"))
    look = look_key(width, height)
    folder = cache_dir / look
    names = {text: _still_name(text) for text in dict.fromkeys(chunk.text for chunk in chunks)}
    missing = [text for text, name in names.items() if not (folder / name).is_file()]
    if missing:
        export._require(export.capabilities(job).libass, "libass", "to draw captions")
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise RpcError(OUTPUT_ERROR, "the captions folder cannot be created") from None
        _draw(missing, names, width, height, cache_dir, folder, job)
    now = time.time()
    for name in names.values():
        # Marks the still as used, so pruning keeps it.
        os.utime(folder / name, (now, now))
    _prune(cache_dir, look)
    return {
        "width": width,
        "height": height,
        "folder": look,
        "drawn": len(missing),
        "chunks": [{"start": c.start, "end": c.end, "png": names[c.text]} for c in chunks],
    }


def _draw(
    texts: list[str], names: dict[str, str], width: int, height: int, cache_dir: Path, folder: Path, job: JobContext
) -> None:
    # Inside the cache, so finished stills move into place on the same volume; removed on any exit.
    try:
        workdir = Path(tempfile.mkdtemp(prefix=".tmp-", dir=cache_dir))
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the captions folder cannot be written") from None
    try:
        timed = [captions_ass.Chunk(text, number, number + 1) for number, text in enumerate(texts)]
        captions_ass.write_ass(workdir / "captions.ass", timed, Fraction(1), width, height)
        captions_ass.link_fonts(workdir / "fonts")
        source = f"color=c=black@0:s={width}x{height}:r=1:d={len(texts)},format=rgba"
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
            timeout=max(QUICK_TOOL_TIMEOUT, SECONDS_PER_STILL * len(texts)),
            cwd=str(workdir),
        )
        for number, text in enumerate(texts):
            still = workdir / f"still-{number:05d}.png"
            if not still.exists():
                raise RpcError(OUTPUT_ERROR, "ffmpeg did not draw every caption")
            os.replace(still, folder / names[text])
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


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
