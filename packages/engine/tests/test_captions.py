# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`captions.render` (S7V-075): the player's caption stills are the export's chunks, drawn by libass."""

from __future__ import annotations

import struct
import subprocess
import zlib
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from engine_support import FFMPEG, Wire
from export_support import make_edit

from s7engine import captions_ass, captions_from_words
from s7engine.jobs import JobContext
from s7engine.methods import captions, export

W, H = 288, 512


def _edit(tmp_path: Path, ranges: list[tuple[int, int]], items: list[dict[str, Any]], rate: Fraction = Fraction(30)) -> dict[str, Any]:
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"")
    return make_edit(source=source, ranges=ranges, fps=rate, duration_frames=10_000, width=W, height=H, captions=items)


def _transcript(words: list[tuple[str, int, int]]) -> dict[str, Any]:
    return {"media": "cam", "fps": {"num": 30, "den": 1}, "words": [{"text": t, "startFrame": s, "endFrame": e} for t, s, e in words]}


def _track_items(plan: export.Plan, transcript: dict[str, Any]) -> list[dict[str, Any]]:
    """The caption items "add captions" writes: one per uncut run, words in timeline frames."""
    items = []
    for index, group in enumerate(captions_from_words.map_words(plan.segments, {"cam": transcript}, plan.rate)):
        start, end = group[0].start, max(word.end for word in group)
        items.append(
            {
                "id": f"c{index + 1}",
                "start": start,
                "duration": end - start,
                "text": " ".join(word.text for word in group),
                "words": [{"text": word.text, "start": word.start, "duration": word.end - word.start} for word in group],
            }
        )
    return items


SPOKEN = [("So", 0, 5), ("today", 6, 11), ("we", 12, 17), ("cut", 18, 23), ("the", 24, 29), ("silences.", 30, 35),
          ("Then", 66, 71), ("across", 85, 125), ("we", 130, 135), ("add", 136, 141), ("captions", 142, 147)]


def test_render_chunks_equal_the_export_chunks(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 40), (60, 90), (120, 160)], [])
    plan = export.plan_segments(edit, W, H)
    transcript = _transcript(SPOKEN)
    fallback = export.export_chunks(edit, plan, {"transcripts": [transcript]})
    edit["tracks"][1]["items"] = _track_items(plan, transcript)
    # The track has one item per uncut run, so its chunks are the transcript fallback's (AC-7).
    assert export.export_chunks(edit, plan, {}) == fallback
    assert captions.chunks_of(edit) == fallback
    assert [c.text for c in fallback][:2] == ["So today we", "cut the silences."]


def test_muted_caption_track_gives_no_chunks(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 90)], [{"id": "c1", "start": 0, "duration": 20, "text": "hello there"}])
    assert len(captions.chunks_of(edit)) == 1
    edit["tracks"][1]["muted"] = True
    assert captions.chunks_of(edit) == []


def test_chunks_end_with_the_timeline(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 30)], [{"id": "c1", "start": 20, "duration": 40, "text": "past the end"}])
    assert [(c.start, c.end) for c in captions.chunks_of(edit)] == [(20, 30)]


def test_no_captions_writes_no_stills(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 30)], [])
    result = captions._render({"edit": edit, "outDir": str(tmp_path / "out")}, JobContext.detached())
    assert result == {"width": W, "height": H, "chunks": []}
    assert list((tmp_path / "out").iterdir()) == []


def _png_size_and_mode(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width, height, _depth, colour = struct.unpack(">IIBB", data[16:26])
    return width, height, colour


def _alpha(path: Path) -> bytes:
    assert FFMPEG is not None
    return subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-vf", "format=rgba,alphaextract,format=gray", "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout


@pytest.mark.usefixtures("tools")
def test_render_draws_one_transparent_still_per_text(tmp_path: Path) -> None:
    items = [
        {"id": "c1", "start": 0, "duration": 20, "text": "hello there"},
        {"id": "c2", "start": 30, "duration": 20, "text": "hello there"},
        {"id": "c3", "start": 60, "duration": 20, "text": "{\\b0}plain"},
    ]
    edit = _edit(tmp_path, [(0, 90)], items)
    out = tmp_path / "stills"
    result = captions._render({"edit": edit, "outDir": str(out)}, JobContext.detached())
    chunks = result["chunks"]
    assert [(c["start"], c["end"]) for c in chunks] == [(0, 20), (30, 50), (60, 80)]
    # The same text shares one still; the look depends only on the text and the canvas.
    assert chunks[0]["png"] == chunks[1]["png"] != chunks[2]["png"]
    assert sorted(p.name for p in out.iterdir()) == sorted({c["png"] for c in chunks})
    for name in {c["png"] for c in chunks}:
        assert _png_size_and_mode(out / name) == (W, H, 6)  # RGBA
        alpha = _alpha(out / name)
        layout = captions_ass.layout_for(W, H)
        # Text is drawn (opaque pixels) inside the safe zone only; the rest is transparent.
        drawn = [i for i, a in enumerate(alpha) if a > 0]
        assert drawn and max(a for a in alpha) == 255
        rows = {i // W for i in drawn}
        assert min(rows) >= layout.safe[1] and max(rows) < layout.safe[3]
    assert zlib.crc32((out / chunks[0]["png"]).read_bytes()) == zlib.crc32((out / chunks[1]["png"]).read_bytes())


def test_render_over_rpc_refuses_bad_params(wire: Wire, tmp_path: Path) -> None:
    reply = wire.call("captions.render", {"edit": {"version": 1}, "outDir": str(tmp_path)})
    assert reply["error"]["code"] == -32602
    reply = wire.call("captions.render", {"edit": _edit(tmp_path, [(0, 30)], []), "outDir": "relative"})
    assert reply["error"]["code"] == -32602
