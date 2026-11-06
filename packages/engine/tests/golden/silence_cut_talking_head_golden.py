# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``silence-cut-talking-head``, export half (S7V-027 check 2).

The TypeScript golden of the same name cuts ``talking-head-01``'s pauses and stores the keep ranges
at 23.976, 29.97 and 25 fps in ``references/silence-cut-talking-head.json``. This half renders the
29.97 and 25 fps edits with ``export.render`` (S7V-028) and matches every output frame to the
source at that rate (same scale and crop, small grey frames, the expected frame and two on each
side). The matches, read back as keep ranges, must equal the edit's (``harness.cut_list_diff``):
no join is a frame early or late. Run with ``pnpm test:golden -- silence-cut-talking-head``.
"""

from __future__ import annotations

import json
import os
import subprocess
from fractions import Fraction
from pathlib import Path

import pytest

import harness
from export_support import make_edit
from s7engine.jobs import JobContext
from s7engine.methods import export

REFERENCE = Path(__file__).parent / "references" / "silence-cut-talking-head.json"
WIDTH, HEIGHT = 360, 640
THUMB = (72, 128)


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _gray_frames(path: Path, prefix: str) -> list[bytes]:
    cover = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT}," if prefix else ""
    chain = f"{prefix}{cover}scale={THUMB[0]}:{THUMB[1]}:flags=area,format=gray"
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf", chain, "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    step = THUMB[0] * THUMB[1]
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


@pytest.mark.parametrize("rate", ["30000/1001", "25/1"])
def test_silence_cut_joins_are_frame_exact(media, tmp_path: Path, rate: str) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    if not REFERENCE.exists():
        pytest.fail(f"no reference at {REFERENCE}; run the TypeScript half with S7VIDEO_GOLDEN_UPDATE=1")
    cut = json.loads(REFERENCE.read_text(encoding="utf-8"))["rates"][rate]
    fps = Fraction(rate)
    ranges = [tuple(span) for span in cut["ranges"]]
    edit = make_edit(
        source=source, ranges=ranges, fps=fps, duration_frames=cut["mediaFrames"], width=WIDTH, height=HEIGHT
    )
    out = tmp_path / "cut.mp4"
    result = export._render(
        {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(out), "captions": False}, JobContext.detached()
    )
    total = sum(end - start for start, end in ranges)
    assert result["durationFrames"] == total
    assert harness.probe_summary(out)["video_frames"] == total

    source_frames = _gray_frames(source, f"fps={fps.numerator}/{fps.denominator},")
    output_frames = _gray_frames(out, "")
    expected = [frame for start, end in ranges for frame in range(start, end)]
    assert len(output_frames) == len(expected)
    matched = []
    for frame, want in zip(output_frames, expected):
        window = range(max(0, want - 2), min(len(source_frames), want + 3))
        best = min(window, key=lambda candidate: (_mse(frame, source_frames[candidate]), abs(candidate - want)))
        # At 29.97 the rate change repeats source pictures: a repeat of the wanted picture is it.
        matched.append(want if source_frames[best] == source_frames[want] else best)
    diff = harness.cut_list_diff(ranges, _runs(matched))
    assert diff is None, str(diff)
    out.unlink()
