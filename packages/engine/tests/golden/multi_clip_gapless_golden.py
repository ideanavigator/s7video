# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``multi-clip-gapless``, export half (S7V-039): ``export.render`` of a 12-segment edit
drawn from three synthetic sources (different sizes and keyframe spacing) and ``talking-head-01``
(23.976 fps in a 30 fps edit), with a black gap and clips out of source order. It is the layout
the player's golden plays (``apps/web/src/components/editor/multi-clip-gapless.golden.test.ts``),
so the preview and the export are checked on the same edit. Checked on:

- **cut list**: every output frame is matched to its source (same fps, scale and crop, grey
  thumbnails) among its expected frame and two on each side; the matches must be exact, and the
  gap must be black;
- **duration and A/V sync**: frame count exact, audio length and start within one frame;
- **pictures at every join**: SSIM ≥ 0.98 and pHash ≤ 6 on the frames either side of each join,
  against the same source frames decoded independently.

No reference file: every expectation comes from the edit and the sources.
Run with ``pnpm test:golden -- multi-clip-gapless``.
"""

from __future__ import annotations

import os
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

import harness
from s7engine.jobs import JobContext
from s7engine.methods import export

RATE = Fraction(30, 1)
WIDTH, HEIGHT = 1280, 720
THUMB = (64, 36)
SSIM_MIN = 0.98
PHASH_MAX = 6
SYNTH = {
    "a": {"name": "multi-clip-a", "width": 1280, "height": 720, "gop": 30, "audio": [{"seconds": 12, "toneHz": 440}]},
    "b": {"name": "multi-clip-b", "width": 1920, "height": 1080, "gop": 60, "audio": [{"seconds": 12, "toneHz": 660}]},
    "c": {"name": "multi-clip-c", "width": 640, "height": 360, "gop": 15, "audio": [{"seconds": 12, "toneHz": 880}]},
}
# (media, in, duration) at the edit's 30 fps; "th" is talking-head-01. A gap before item 7.
LAYOUT = [
    ("a", 10, 30), ("b", 47, 25), ("c", 73, 40), ("th", 900, 20), ("b", 5, 33), ("c", 200, 28),
    ("a", 260, 31), ("b", 150, 22), ("c", 17, 35), ("th", 300, 26), ("b", 300, 30), ("c", 290, 24),
]
GAP_BEFORE, GAP_FRAMES = 7, 15


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _cover(untagged: bool) -> str:
    """The source as export draws it on the canvas: edit fps, scaled to cover (to BT.709 limited
    range, as ``_video_chain`` does, reading untagged synthetic clips as BT.709), centre-cropped."""
    return (
        f"fps={RATE.numerator}/{RATE.denominator},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase"
        f"{':in_color_matrix=bt709' if untagged else ''}:out_color_matrix=bt709:out_range=tv,"
        f"crop={WIDTH}:{HEIGHT},setsar=1,format=yuv420p,"
    )


def _gray_frames(path: Path, chain: str) -> list[bytes]:
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf",
         f"{chain}scale={THUMB[0]}:{THUMB[1]}:flags=area,format=gray", "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    step = THUMB[0] * THUMB[1]
    return [raw[index * step : (index + 1) * step] for index in range(len(raw) // step)]


def _mse(a: bytes, b: bytes) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)


def _frame_png(path: Path, frame: int, chain: str, out: Path) -> Path:
    harness._run(
        [harness._tool("ffmpeg"), "-v", "error", "-y", "-i", str(path), "-map", "0:v:0", "-vf",
         f"{chain}select='eq(n\\,{frame})',format=gray", "-fps_mode", "passthrough", "-frames:v", "1", str(out)]
    )
    return out


def _edit(paths: dict[str, Path], durations: dict[str, int]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    items, at = [], 0
    for index, (media, source_in, duration) in enumerate(LAYOUT):
        if index == GAP_BEFORE:
            at += GAP_FRAMES
        items.append({"id": f"v{index}", "media": media, "start": at, "duration": duration, "in": source_in})
        at += duration
    media = [
        {
            "id": key,
            "kind": "video",
            "reference": str(path),
            "fingerprint": {"sha256": "0" * 64, "size": path.stat().st_size},
            "probe": {"hasVideo": True, "hasAudio": True, "durationFrames": durations[key]},
        }
        for key, path in paths.items()
    ]
    edit = {
        "version": 1,
        "fps": {"num": RATE.numerator, "den": RATE.denominator},
        "canvas": {"width": WIDTH, "height": HEIGHT},
        "media": media,
        "tracks": [{"kind": "video", "id": "V1", "role": "main", "items": items}],
        "markers": [],
        "metadata": {},
    }
    return edit, items


def test_multi_clip_gapless_export(media, tmp_path: Path) -> None:
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    paths = {key: harness.synth(spec) for key, spec in SYNTH.items()}
    paths["th"] = media("talking-head-01")
    durations = {key: 360 for key in SYNTH} | {"th": 4200}
    edit, items = _edit(paths, durations)
    total = items[-1]["start"] + items[-1]["duration"]

    result = export._render(
        {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(tmp_path / "out.mp4"), "captions": False},
        JobContext.detached(),
    )
    out = Path(result["path"])

    # Duration and A/V sync (AC-4).
    summary = harness.probe_summary(out)
    frame_s = float(1 / RATE)
    assert summary["video_frames"] == result["durationFrames"] == total
    assert (summary["width"], summary["height"], summary["fps"]) == (WIDTH, HEIGHT, "30/1")
    assert abs(summary["audio_start_s"] - summary["video_start_s"]) <= frame_s
    assert abs(summary["audio_duration_s"] - total * frame_s) <= frame_s

    # Cut list: each output frame is the expected source frame, exactly; the gap is black.
    sources = {key: _gray_frames(path, _cover(key in SYNTH)) for key, path in paths.items()}
    output = _gray_frames(out, "")
    assert len(output) == total
    by_frame: dict[int, tuple[str, int]] = {}
    for item in items:
        for offset in range(item["duration"]):
            by_frame[item["start"] + offset] = (item["media"], item["in"] + offset)
    mismatches = []
    for position, frame in enumerate(output):
        expected = by_frame.get(position)
        if expected is None:
            assert sum(frame) / len(frame) < 20, f"frame {position} in the gap is not black"
            continue
        key, want = expected
        candidates = sources[key]
        window = range(max(0, want - 2), min(len(candidates), want + 3))
        got = min(window, key=lambda candidate: _mse(frame, candidates[candidate]))
        # At 23.976 fps in a 30 fps edit the fps filter repeats a frame; equal frames tie.
        if got != want and candidates[got] != candidates[want]:
            mismatches.append((position, key, want, got))
    assert mismatches == [], mismatches[:10]

    # Pictures either side of every join.
    joins = []
    for index, item in enumerate(items):
        if index > 0:
            joins.append(item["start"] - 1 if index != GAP_BEFORE else None)
        joins.append(item["start"])
    worst = (1.0, 0)
    for position in [frame for frame in joins if frame is not None]:
        key, source_frame = by_frame[position]
        ref = _frame_png(paths[key], source_frame, _cover(key in SYNTH), tmp_path / f"ref-{position}.png")
        cand = _frame_png(out, position, "", tmp_path / f"cand-{position}.png")
        score = harness.ssim(ref, cand).min
        distance = harness.phash_distance(harness.phash(ref), harness.phash(cand))
        worst = (min(worst[0], score), max(worst[1], distance))
        assert score >= SSIM_MIN, f"edit frame {position} ({key} {source_frame}): SSIM {score:.4f}"
        assert distance <= PHASH_MAX, f"edit frame {position} ({key} {source_frame}): pHash {distance}"
        ref.unlink()
        cand.unlink()
    print(
        f"\nmulti-clip-gapless: {len(items)} segments, {total} frames, cut list exact, "
        f"worst join SSIM {worst[0]:.4f}, pHash {worst[1]}"
    )
    out.unlink()
