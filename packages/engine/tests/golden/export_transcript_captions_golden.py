# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``export-transcript-captions``: captions from the transcript on ``talking-head-01`` (S7V-046).

The edit keeps 21 ranges (20 cuts, 60.0 s) of the 140 s clip as a 1080×1920 reel at 24000/1001 and
has an empty caption track, so ``export.render`` draws the captions from the clip's transcript. The
transcript is ``fixtures/media/talking-head-01.transcript.json``: the cache file of a real
Qwen3-ASR 1.7B + ForcedAligner run (S7V-026), stored so this golden needs no models. Point
``S7VIDEO_GOLDEN_TRANSCRIPT`` at a freshly made cache file to check a new transcript agrees.

Checked:

- **mapping**: each word kept by the cut is on the timeline at its source frames shifted by the
  removed frames before it (computed here independently of the engine); no word wholly in a
  removed range is shown; no caption spans a cut join;
- **chunks**: 2–4 words, or a single word that is a whole phrase (a pause or a cut on both sides),
  equal to the stored reference;
- **pixels**: from the difference between a captioned and a plain render, each caption appears on
  its first frame and leaves on its last (±1), and nothing outside the safe zone changes.

Record a new reference with ``S7VIDEO_GOLDEN_UPDATE=1`` and say why in the PR.
Run with ``pnpm test:golden -- export-transcript-captions``.
"""

from __future__ import annotations

import json
import os
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

import harness
from export_support import keep_ranges, make_edit, timeline_of
from s7engine import captions_ass
from s7engine.jobs import JobContext
from s7engine.methods import export

REFERENCE = Path(__file__).parent / "references" / "export-transcript-captions.json"
TRANSCRIPT = Path(
    os.environ.get("S7VIDEO_GOLDEN_TRANSCRIPT") or harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.transcript.json"
)
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
SEGMENTS, TOTAL = 21, 1438
WIDTH, HEIGHT = 1080, 1920
TEXT_DIFF = 60


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _band_frames(path: Path, band: tuple[int, int, int, int]) -> list[bytes]:
    left, top, right, bottom = band
    size = ((right - left) // 4, (bottom - top) // 4)
    chain = f"crop={right - left}:{bottom - top}:{left}:{top},scale={size[0]}:{size[1]}:flags=area,format=gray"
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-vf", chain, "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    step = size[0] * size[1]
    return [raw[index * step : (index + 1) * step] for index in range(len(raw) // step)]


def _text_mask(captioned: bytes, plain: bytes) -> frozenset[int]:
    return frozenset(index for index, (a, b) in enumerate(zip(captioned, plain)) if abs(a - b) > TEXT_DIFF)


def _expected_words(words: list[dict[str, Any]], ranges: list[tuple[int, int]]) -> list[tuple[str, int, int]]:
    """Each word's kept frames per keep range, on the timeline: the mapping, done independently."""
    kept = []
    for word in words:
        for start, end in ranges:
            low, high = max(word["startFrame"], start), min(word["endFrame"], end)
            if high > low:
                kept.append((word["text"], timeline_of(ranges, low), timeline_of(ranges, high - 1) + 1))
    return sorted(kept, key=lambda entry: entry[1])


def test_export_transcript_captions(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    transcript = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    assert transcript["fps"] == {"num": RATE.numerator, "den": RATE.denominator}
    ranges = keep_ranges(SOURCE_FRAMES, SEGMENTS, TOTAL)
    edit = make_edit(source=source, ranges=ranges, fps=RATE, duration_frames=SOURCE_FRAMES, captions=[])
    words = [{key: word[key] for key in ("text", "startFrame", "endFrame")} for word in transcript["words"]]
    params = {"transcripts": [{"media": "cam", "fps": transcript["fps"], "words": words}]}
    chunks = export.export_chunks(edit, export.plan_segments(edit, WIDTH, HEIGHT), params)

    # Mapping: the words the chunks show are exactly the kept words, at their mapped frames.
    expected = _expected_words(transcript["words"], ranges)
    shown = [word for chunk in chunks for word in chunk.text.split()]
    assert shown == [text for text, _, _ in expected]
    removed = [word for word in transcript["words"] if not any(word["endFrame"] > a and word["startFrame"] < b for a, b in ranges)]
    assert removed, "the cut list should remove some words"
    at = 0
    for index, chunk in enumerate(chunks):
        count = len(chunk.text.split())
        group = expected[at : at + count]
        at += count
        # From the first word's start to the last word's end, cut short only by the next caption.
        following = chunks[index + 1].start if index + 1 < len(chunks) else TOTAL
        assert (chunk.start, chunk.end) == (group[0][1], min(group[-1][2], following)), (chunk, group)
    joins = []
    timeline = 0
    for start, end in ranges[:-1]:
        timeline += end - start
        joins.append(timeline)
    for chunk in chunks:
        assert not any(chunk.start < join < chunk.end for join in joins), chunk

    # Chunks: 2–4 words; one word only as a whole phrase (a break both before and after it).
    pause = Fraction(str(captions_ass.load_style()["chunk"]["pauseSeconds"])) * RATE
    edges = {0, TOTAL, *joins}
    for index, chunk in enumerate(chunks):
        count = len(chunk.text.split())
        assert 1 <= count <= 4, chunk
        if count == 1:
            before = index == 0 or chunk.start in edges or chunk.start - chunks[index - 1].end >= pause
            after = index + 1 == len(chunks) or chunk.end in edges or chunks[index + 1].start - chunk.end >= pause
            assert before and after, chunk
    observed = {
        "clip": "talking-head-01",
        "ranges": [list(r) for r in ranges],
        "chunks": [[chunk.text, chunk.start, chunk.end] for chunk in chunks],
    }
    if UPDATE:
        REFERENCE.write_text(json.dumps(observed, indent=2) + "\n", encoding="utf-8")
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    assert observed == reference

    # Pixels: render with and without captions; the difference is the caption text.
    out = tmp_path / "captioned.mp4"
    bare = tmp_path / "plain.mp4"
    for path, captions in ((out, True), (bare, False)):
        result = export._render(
            {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(path), "captions": captions, **params},
            JobContext.detached(),
        )
        assert result["durationFrames"] == TOTAL
    assert result["captions"] == 0
    safe = captions_ass.layout_for(WIDTH, HEIGHT).safe
    masks = [_text_mask(a, b) for a, b in zip(_band_frames(out, safe), _band_frames(bare, safe))]
    assert len(masks) == TOTAL
    for chunk in chunks:
        inside = range(chunk.start + 1, chunk.end - 1)
        assert all(masks[frame] for frame in inside), chunk
        # The text changes on its first frame and on its last (±1): new text, or none after it.
        for edge in (chunk.start, chunk.end):
            if 0 < edge < TOTAL:
                assert any(masks[frame] != masks[frame - 1] for frame in range(max(1, edge - 1), min(TOTAL, edge + 2))), (chunk, edge)
    showing = {frame for chunk in chunks for frame in range(chunk.start - 1, chunk.end + 1)}
    for frame, mask in enumerate(masks):
        if frame not in showing:
            assert not mask, f"text on frame {frame}, where no caption is"
    # Nothing outside the safe zone differs between the two renders.
    full = (0, 0, WIDTH, HEIGHT)
    left, top, right, bottom = safe
    width = WIDTH // 4
    whole = [_text_mask(a, b) for a, b in zip(_band_frames(out, full), _band_frames(bare, full))]
    for chunk in chunks:
        for index in whole[chunk.start + (chunk.end - chunk.start) // 2]:
            x, y = (index % width) * 4, (index // width) * 4
            assert left - 4 <= x < right and top - 4 <= y < bottom, (chunk.text, x, y)

    out.unlink()
    bare.unlink()
