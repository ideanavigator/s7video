# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``export-captions-talking-head``: ``export.render`` on ``talking-head-01`` (S7V-028).

The edit keeps 58 short ranges (60.0 s) of the 140 s clip as a 1080×1920 reel at 24000/1001, with
a caption for every hand-marked word (``fixtures/media/talking-head-01.words.json``) the cut keeps
whole. It is rendered twice, with and without captions, and checked on:

- **cut list**: every output frame is matched to the source (same scale and crop, 108×192 grey)
  among its expected frame and the two on each side; the matches, as keep ranges, must equal the
  edit's (``harness.cut_list_diff``), and the frame count is the sum of the ranges;
- **pictures**: SSIM ≥ 0.98 between sampled output frames and the same source frames decoded
  independently, and pHash ≤ 6 against the stored reference on sampled frames with captions;
- **captions**: from the difference between the two renders, each caption appears on its first
  word's start frame and leaves on its last word's end frame (±1), inside the safe zone;
- **loudness**: −14 LUFS ±1 LU, within 0.5 LU of the reference, true peak ≤ −1.0 dBTP;
- **A/V sync, codecs and colour tags** from ``harness.probe_summary``;
- **time**: the captioned render of 60 s takes under 30 s (printed; PRD-002 target).

The reference holds data only (ranges, chunks, summary, loudness, pHashes). A legitimate change is
recorded with ``S7VIDEO_GOLDEN_UPDATE=1`` and explained in the PR.
Run with ``pnpm test:golden -- export-captions-talking-head``.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

import harness
from export_support import caption_items_from_words, keep_ranges, make_edit
from s7engine import captions_ass
from s7engine.jobs import JobContext
from s7engine.methods import export

REFERENCE = Path(__file__).parent / "references" / "export-captions-talking-head.json"
WORDS = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.words.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
SEGMENTS, TOTAL = 58, 1438  # 1438 frames at 24000/1001 = 60.0 s
WIDTH, HEIGHT = 1080, 1920
THUMB = (108, 192)
SSIM_MIN = 0.98
PHASH_MAX = 6
LUFS_TOLERANCE = 0.5
TIME_LIMIT_S = 30.0


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _gray_frames(path: Path, prefix: str, size: tuple[int, int], crop: str = "") -> list[bytes]:
    cover = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT}," if prefix else ""
    chain = f"{prefix}{cover}{crop}scale={size[0]}:{size[1]}:flags=area,format=gray"
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-vf", chain, "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    step = size[0] * size[1]
    return [raw[index * step : (index + 1) * step] for index in range(len(raw) // step)]


def _mse(a: bytes, b: bytes) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)


def _runs(frames: list[int]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for frame in frames:
        if ranges and frame == ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], frame + 1)
        else:
            ranges.append((frame, frame + 1))
    return ranges


def _sample_frames(path: Path, frames: list[int], folder: Path, prefix: str) -> list[Path]:
    """The given frames as numbered grey PNGs (SSIM on luma), from one decode pass."""
    folder.mkdir()
    select = "+".join(f"eq(n\\,{frame})" for frame in frames)
    cover = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT}," if prefix else ""
    harness._run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf",
         f"{prefix}select='{select}',{cover}format=gray", "-fps_mode", "passthrough", str(folder / "%03d.png")]
    )
    written = sorted(folder.glob("*.png"))
    assert len(written) == len(frames)
    return written


def _render(edit: dict[str, Any], out: Path, captions: bool) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    result = export._render(
        {"edit": edit, "projectDir": str(out.parent), "outputPath": str(out), "captions": captions}, JobContext.detached()
    )
    return result, time.perf_counter() - started


def test_export_captions_talking_head(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    ranges = keep_ranges(SOURCE_FRAMES, SEGMENTS, TOTAL)
    words = json.loads(WORDS.read_text(encoding="utf-8"))["words"]
    captions = caption_items_from_words(words, ranges)
    edit = make_edit(source=source, ranges=ranges, fps=RATE, duration_frames=SOURCE_FRAMES, captions=captions)
    chunks = captions_ass.caption_chunks(captions, RATE, TOTAL)

    captioned, seconds = _render(edit, tmp_path / "captioned.mp4", True)
    plain, _ = _render(edit, tmp_path / "plain.mp4", False)
    out, bare = Path(captioned["path"]), Path(plain["path"])
    print(f"\nexport-captions-talking-head: 60 s reel with {len(chunks)} captions rendered in {seconds:.1f} s")

    summary = harness.probe_summary(out)
    loud = harness.loudness(out)
    picks = sorted({0, TOTAL - 1, *(chunk.start + (chunk.end - chunk.start) // 2 for chunk in chunks[:6])})
    observed = {
        "clip": "talking-head-01",
        "ranges": [list(r) for r in ranges],
        "chunks": [[chunk.text, chunk.start, chunk.end] for chunk in chunks],
        "summary": summary,
        "lufs": loud.integrated_lufs,
        "truePeak": loud.true_peak_dbtp,
        "phash": {str(frame): format(harness.phash(out, frame), "016x") for frame in picks},
    }
    if UPDATE:
        REFERENCE.write_text(json.dumps(observed, indent=2) + "\n", encoding="utf-8")
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))

    # Time (AC-1).
    assert seconds < TIME_LIMIT_S, f"export took {seconds:.1f} s"

    # Format, frame count, colour tags, A/V sync (AC-2, AC-6, AC-7).
    assert summary == reference["summary"]
    assert (summary["video_codec"], summary["pix_fmt"], summary["fps"]) == ("h264", "yuv420p", "24000/1001")
    assert (summary["audio_codec"], summary["audio_rate"], summary["audio_channels"]) == ("aac", 48000, 2)
    assert (summary["color_primaries"], summary["color_transfer"], summary["color_space"], summary["color_range"]) == (
        "bt709", "bt709", "bt709", "tv",
    )
    assert summary["video_frames"] == captioned["durationFrames"] == TOTAL
    frame_s = float(1 / RATE)
    assert abs(summary["audio_start_s"] - summary["video_start_s"]) <= frame_s
    assert abs(summary["audio_duration_s"] - TOTAL * frame_s) <= frame_s

    # Cut list against the source, frame by frame (AC-2).
    source_frames = _gray_frames(source, f"fps={RATE.numerator}/{RATE.denominator},", THUMB)
    output_frames = _gray_frames(bare, "", THUMB)
    expected = [frame for start, end in ranges for frame in range(start, end)]
    assert len(output_frames) == len(expected)
    matched = []
    for frame, want in zip(output_frames, expected):
        window = range(max(0, want - 2), min(len(source_frames), want + 3))
        matched.append(min(window, key=lambda candidate: _mse(frame, source_frames[candidate])))
    diff = harness.cut_list_diff([tuple(r) for r in reference["ranges"]], _runs(matched))
    assert diff is None, str(diff)

    # Pictures: SSIM against independently decoded source frames, pHash against the reference.
    samples = sorted({start for start, _ in ranges[::6]} | {end - 1 for _, end in ranges[::7]})
    out_positions = [expected.index(frame) for frame in samples]
    references = _sample_frames(source, samples, tmp_path / "ref", f"fps={RATE.numerator}/{RATE.denominator},")
    candidates = _sample_frames(bare, out_positions, tmp_path / "cand", "")
    for frame, ref, cand in zip(samples, references, candidates):
        score = harness.ssim(ref, cand).min
        assert score >= SSIM_MIN, f"source frame {frame}: SSIM {score:.4f}"
    for frame, value in reference["phash"].items():
        distance = harness.phash_distance(harness.phash(out, int(frame)), int(value, 16))
        assert distance <= PHASH_MAX, f"frame {frame}: pHash distance {distance}"

    # Captions: on and off at their word frames, inside the safe zone (AC-3, AC-4).
    assert [[c.text, c.start, c.end] for c in chunks] == reference["chunks"]
    left, top, right, bottom = captions_ass.layout_for(WIDTH, HEIGHT).safe
    band = f"crop={right - left}:{bottom - top}:{left}:{top},"
    size = ((right - left) // 4, (bottom - top) // 4)
    with_text = _gray_frames(out, "", size, band)
    without = _gray_frames(bare, "", size, band)
    shown = [max(abs(a - b) for a, b in zip(x, y)) > 60 for x, y in zip(with_text, without)]
    visible = _runs([index for index, on in enumerate(shown) if on])
    expected_spans = [(chunk.start, chunk.end) for chunk in chunks]
    assert len(visible) == len(expected_spans), (visible, expected_spans)
    for (start, end), (want_start, want_end) in zip(visible, expected_spans):
        assert abs(start - want_start) <= 1 and abs(end - want_end) <= 1, ((start, end), (want_start, want_end))
    # Nothing outside the safe zone differs between the two renders, on any caption frame.
    whole_with = _gray_frames(out, "", THUMB)
    whole_without = output_frames
    sx, sy = WIDTH / THUMB[0], HEIGHT / THUMB[1]
    for chunk in chunks:
        frame = chunk.start + (chunk.end - chunk.start) // 2
        a, b = whole_with[frame], whole_without[frame]
        for index in range(len(a)):
            if abs(a[index] - b[index]) > 40:
                x, y = (index % THUMB[0]) * sx, (index // THUMB[0]) * sy
                assert left - sx <= x < right and top - sy <= y < bottom, (chunk.text, x, y)

    # Loudness (AC-5).
    assert abs(loud.integrated_lufs - -14.0) <= 1.0
    assert abs(loud.integrated_lufs - reference["lufs"]) <= LUFS_TOLERANCE
    assert loud.true_peak_dbtp <= -1.0

    for path in (out, bare, *references, *candidates):
        path.unlink()
