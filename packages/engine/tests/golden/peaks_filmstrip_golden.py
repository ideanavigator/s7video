# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``peaks-filmstrip``: the timeline's waveform and filmstrip data (S7V-035).

- ``media.peaks`` on ``talking-head-01``: every level matches min/max computed here with numpy from
  an independent decode of the same PCM, within 1 LSB of 16-bit full scale, and 256 evenly spaced
  peaks per level match the stored reference within the same tolerance.
- ``media.filmstrip`` on a 60 s synthetic ``testsrc2`` (its counter changes every frame): sampled
  tiles of every level match FFmpeg's own frame at the indexed frame, scaled the same, at SSIM
  ≥ 0.98 and pHash ≤ 6; the neighbouring frame scores below that, so an off-by-one fails.
- Timing (opt in with ``S7VIDEO_GOLDEN_LONG=1``; it writes a 3 GB source to a temp folder and
  deletes it): a 30-minute 1080p30 H.264 source gets its peaks and every filmstrip level within
  60 s, and the peaks pass peaks below 500 MB of memory.

References are data (JSON). Record a legitimate change with ``S7VIDEO_GOLDEN_UPDATE=1``.
Run with ``pnpm test:golden -- peaks-filmstrip``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest

import harness
from s7engine.jobs import JobContext
from s7engine.methods import filmstrip, peaks

REFERENCE = Path(__file__).parent / "references" / "peaks-filmstrip.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
LONG = os.environ.get("S7VIDEO_GOLDEN_LONG") == "1"
LSB = 1 / 32768
SAMPLED_PEAKS = 256
SSIM_MIN = 0.98
PHASH_MAX = 6
TIMING_LIMIT_S = 60
PEAKS_RSS_LIMIT_MB = 500

SYNTH_COUNTER = {"name": "peaks-filmstrip-counter", "fps": "30/1", "width": 640, "height": 360, "audio": [{"seconds": 60, "toneHz": 440}]}


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _reference() -> dict:
    return json.loads(REFERENCE.read_text(encoding="utf-8")) if REFERENCE.exists() else {}


def _save(key: str, record: dict) -> None:
    reference = _reference()
    reference[key] = record
    REFERENCE.write_text(json.dumps(reference, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _pcm(clip: Path) -> np.ndarray:
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(clip), "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


def _numpy_peaks(pcm: np.ndarray, samples_per_peak: int) -> np.ndarray:
    """The reference: pad the tail with its own last sample, then min/max of every row."""
    rows = -(-len(pcm) // samples_per_peak)
    padded = np.concatenate([pcm, np.full(rows * samples_per_peak - len(pcm), pcm[-1], dtype=np.float32)])
    grid = padded.reshape(rows, samples_per_peak)
    return np.stack([grid.min(axis=1), grid.max(axis=1)], axis=1)


def test_talking_head_peaks_match_numpy_at_every_level(media, tmp_path: Path) -> None:
    clip = media("talking-head-01")
    out = tmp_path / "peaks"
    result = peaks.METHOD.handler({"path": str(clip), "outputDir": str(out)}, JobContext.detached())
    assert result["audio"] is True
    pcm = _pcm(clip)
    assert result["durationSamples"] == len(pcm)
    record: dict = {"durationSamples": len(pcm), "offsetSamples": result["offsetSamples"], "levels": {}}
    for entry in result["levels"]:
        size = entry["samplesPerPeak"]
        written = np.fromfile(out / entry["file"], dtype="<f4").reshape(-1, 2)
        expected = _numpy_peaks(pcm, size)
        assert written.shape == expected.shape, f"level {size}: {written.shape} vs {expected.shape}"
        worst = float(np.max(np.abs(written - expected)))
        assert worst <= LSB, f"level {size}: off by {worst * 32768:.2f} LSB"
        picks = np.linspace(0, len(written) - 1, SAMPLED_PEAKS).round().astype(int)
        record["levels"][str(size)] = {
            "count": len(written),
            "sampled": np.rint(written[picks] * 32767).astype(int).tolist(),
        }
    if UPDATE:
        _save("talking-head-01", record)
        return
    stored = _reference()["talking-head-01"]
    assert record["durationSamples"] == stored["durationSamples"]
    assert record["offsetSamples"] == stored["offsetSamples"]
    for size, level in record["levels"].items():
        expected_level = stored["levels"][size]
        assert level["count"] == expected_level["count"], f"level {size}: count"
        diff = np.abs(np.array(level["sampled"]) - np.array(expected_level["sampled"]))
        assert int(diff.max()) <= 1, f"level {size}: {int(diff.max())} LSB from the reference"


def _still(command: list[str], out: Path) -> Path:
    subprocess.run([harness._tool("ffmpeg"), "-v", "error", *command, "-frames:v", "1", "-y", str(out)], check=True)
    return out


def test_filmstrip_tiles_show_their_indexed_frames(synth_clip, tmp_path: Path) -> None:
    clip = synth_clip(SYNTH_COUNTER)
    out = tmp_path / "filmstrip"
    result = filmstrip.METHOD.handler(
        {"path": str(clip), "outputDir": str(out), "rate": {"num": 30, "den": 1}}, JobContext.detached()
    )
    index = json.loads((out / "index.json").read_text())
    width, height = index["tileWidth"], index["tileHeight"]
    assert (width, height) == (160, 90)
    record: dict = {"levels": {}}
    for level in index["levels"]:
        frames = level["frames"]
        # The first frame at or after every multiple of the level from the first frame.
        step = level["framesPerTile"]
        assert frames == list(range(0, 1800, step)), level["level"]
        hashes = []
        for tile in sorted({0, len(frames) // 2, len(frames) - 1}):
            frame = frames[tile]
            sheet, row, column = filmstrip.tile_position(tile)
            # Both as 4:2:0 YUV, so SSIM scores the tile's JPEG loss, not a colour conversion.
            crop = f"crop={width}:{height}:{column * width}:{row * height},format=yuv420p"
            tile_image = _still(["-i", str(out / level["sheets"][sheet - 1]), "-vf", crop], tmp_path / f"{level['level']}-{tile}.y4m")
            # FFmpeg's own frame, scaled the way the engine scales, lossless.
            scale = f"select=eq(n\\,{frame}),scale={width}:{height},format=yuv420p"
            frame_image = _still(["-i", str(clip), "-vf", scale], tmp_path / f"f{frame}.y4m")
            score = harness.ssim(frame_image, tile_image)
            assert score.min >= SSIM_MIN, f"{level['level']} tile {tile} (frame {frame}): SSIM {score.min:.4f}"
            tile_hash = harness.phash(tile_image)
            assert harness.phash_distance(tile_hash, harness.phash(frame_image)) <= PHASH_MAX
            if frame + 1 < 1800:
                near_scale = f"select=eq(n\\,{frame + 1}),scale={width}:{height},format=yuv420p"
                near = _still(["-i", str(clip), "-vf", near_scale], tmp_path / f"n{frame}.y4m")
                assert harness.ssim(near, tile_image).min < SSIM_MIN, f"frame {frame + 1} is indistinguishable"
            hashes.append(f"{tile_hash:016x}")
        record["levels"][level["level"]] = {"count": len(frames), "sheets": len(level["sheets"]), "phash": hashes}
    assert [entry["level"] for entry in result["levels"]] == ["16s", "4s", "1s"]
    if UPDATE:
        _save("synth-counter", record)
        return
    stored = _reference()["synth-counter"]
    for name, level in record["levels"].items():
        expected = stored["levels"][name]
        assert (level["count"], level["sheets"]) == (expected["count"], expected["sheets"])
        for got, want in zip(level["phash"], expected["phash"]):
            assert harness.phash_distance(int(got, 16), int(want, 16)) <= PHASH_MAX


_PEAKS_RSS = """
import resource, sys
from s7engine.jobs import JobContext
from s7engine.methods import peaks
peaks.METHOD.handler({"path": sys.argv[1], "outputDir": sys.argv[2]}, JobContext.detached())
print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
"""


@pytest.mark.skipif(not LONG, reason="set S7VIDEO_GOLDEN_LONG=1 to time a 30-minute source")
def test_thirty_minutes_ready_within_a_minute(tmp_path: Path) -> None:
    source = tmp_path / "thirty.mp4"
    subprocess.run(
        [
            harness._tool("ffmpeg"), "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=1800",
            "-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*440*t)*lt(mod(t,20),12)':s=48000:d=1800",
            "-f", "lavfi", "-i", "anoisesrc=d=1800:c=pink:r=48000:a=0.5",
            "-filter_complex", "[2:a]volume='if(lt(mod(t,20),16),0,1)':eval=frame[n];[1:a][n]amix=inputs=2:normalize=0[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-g", "30",
            "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(source),
        ],
        check=True,
    )  # fmt: skip
    try:
        started = time.perf_counter()
        rss = subprocess.run(
            [sys.executable, "-I", "-c", _PEAKS_RSS, str(source), str(tmp_path / "peaks")],
            check=True,
            capture_output=True,
            text=True,
            env=os.environ.copy(),
        ).stdout
        peaks_s = time.perf_counter() - started
        filmstrip.METHOD.handler(
            {"path": str(source), "outputDir": str(tmp_path / "filmstrip"), "rate": {"num": 30, "den": 1}},
            JobContext.detached(),
        )
        total_s = time.perf_counter() - started
        rss_mb = int(rss.strip().splitlines()[-1]) / 2**20
        print(f"30-minute source: peaks {peaks_s:.1f} s, all levels {total_s:.1f} s, peaks RSS {rss_mb:.0f} MB")
        assert total_s <= TIMING_LIMIT_S
        assert rss_mb < PEAKS_RSS_LIMIT_MB
    finally:
        source.unlink(missing_ok=True)
