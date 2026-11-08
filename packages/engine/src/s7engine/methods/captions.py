# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`captions.render`: the edit's caption chunks as transparent PNG stills, for the player (S7V-075).

The chunks are the export's own (`export.caption_items` and `captions_ass.caption_chunks`), and
each still is drawn by the same ASS file builder and libass, onto a transparent canvas of the
edit's size, so the player shows what the export burns in. One still per distinct chunk text:
the look depends only on the text and the canvas, so the ASS is retimed to one chunk per second
and FFmpeg renders all of them in one run.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

from .. import captions_ass, timebase
from ..ffmpeg import run_tool
from ..jobs import JobContext
from ..edit_schema import validate_edit_document
from ..rpc import INVALID_PARAMS, OUTPUT_ERROR, Method, RpcError
from . import export
from ._media import PATH_SCHEMA

def timeline_end(edit: dict[str, Any]) -> int:
    """The last frame the export plays: the end of the first video track's last item."""
    video = next((track for track in edit["tracks"] if track["kind"] == "video"), None)
    return max((item["start"] + item["duration"] for item in (video or {}).get("items", [])), default=0)


def chunks_of(edit: dict[str, Any]) -> list[captions_ass.Chunk]:
    """The edit's caption chunks as the export draws them from its caption items."""
    rate = timebase.from_rational(edit["fps"])
    return captions_ass.caption_chunks(export.caption_items(edit), rate, timeline_end(edit))


def _render(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    edit = params["edit"]
    issues = validate_edit_document(edit)
    if issues:
        raise RpcError(INVALID_PARAMS, f"the edit is not valid: {issues[0].explanation}")
    out_dir = params["outDir"]
    if not os.path.isabs(out_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at outDir: must be absolute")
    width, height = int(edit["canvas"]["width"]), int(edit["canvas"]["height"])
    chunks = chunks_of(edit)
    texts = list(dict.fromkeys(chunk.text for chunk in chunks))
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the captions folder cannot be created") from None
    if texts:
        export._require(export.capabilities(job).libass, "libass", "to draw captions")
        _draw(texts, width, height, Path(out_dir), job)
    index = {text: number for number, text in enumerate(texts)}
    return {
        "width": width,
        "height": height,
        "chunks": [{"start": chunk.start, "end": chunk.end, "png": _name(index[chunk.text])} for chunk in chunks],
    }


def _name(number: int) -> str:
    return f"still-{number:04d}.png"


def _draw(texts: list[str], width: int, height: int, out_dir: Path, job: JobContext) -> None:
    workdir = Path(tempfile.mkdtemp(prefix="s7captions-"))
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
                "still-%04d.png",
            ],
            job,
            cwd=str(workdir),
        )
        for number in range(len(texts)):
            still = workdir / _name(number)
            if not still.exists():
                raise RpcError(OUTPUT_ERROR, "ffmpeg did not draw every caption")
            os.replace(still, out_dir / _name(number))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


METHOD = Method(
    "captions.render",
    _render,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["edit", "outDir"],
        "properties": {
            "edit": {"type": "object"},
            "outDir": PATH_SCHEMA,
        },
    },
)
