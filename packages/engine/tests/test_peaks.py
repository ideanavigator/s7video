# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.peaks`: the waveform mip the timeline draws (S7V-035)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
from engine_support import FFMPEG, Wire

from s7engine import rpc
from s7engine.methods import peaks

LEVELS = [256, 1024, 4096, 16384]


def _read_level(directory: Path, samples_per_peak: int) -> np.ndarray:
    return np.fromfile(directory / f"{samples_per_peak}.f32", dtype="<f4").reshape(-1, 2)


def _pcm(path: Path) -> np.ndarray:
    assert FFMPEG is not None
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


def test_bucket_peaks_of_known_signals() -> None:
    step = np.concatenate([np.zeros(256), np.ones(256), -np.ones(100)]).astype(np.float32)
    assert peaks.bucket_peaks(step, 256).tolist() == [[0, 0], [1, 1], [-1, -1]]
    sine = np.sin(2 * np.pi * np.arange(4096) / 256).astype(np.float32)
    out = peaks.bucket_peaks(sine, 256)
    assert out.shape == (16, 2)
    assert np.allclose(out[:, 0], -1, atol=1e-6) and np.allclose(out[:, 1], 1, atol=1e-6)


def test_levels_nest_and_match_a_direct_reference() -> None:
    rng = np.random.default_rng(7)
    pcm = rng.uniform(-1, 1, 123_457).astype(np.float32)
    # Blocks that do not line up with any bucket, to exercise the carry between reads.
    blocks = [pcm[i : i + 10_007] for i in range(0, len(pcm), 10_007)]
    total, mip = peaks.peaks_mip(iter(blocks), LEVELS)
    assert total == len(pcm)
    for samples_per_peak, level in zip(LEVELS, mip):
        assert np.array_equal(level, peaks.bucket_peaks(pcm, samples_per_peak))
    for finer, coarser, factor in zip(mip, mip[1:], [4, 4, 4]):
        assert np.array_equal(coarser, peaks.coarsen(finer, factor))


def test_silent_audio_gives_flat_peaks() -> None:
    total, mip = peaks.peaks_mip(iter([np.zeros(50_000, dtype=np.float32)]), LEVELS)
    assert total == 50_000
    assert all(not level.any() for level in mip)
    _, empty = peaks.peaks_mip(iter([]), LEVELS)
    assert [len(level) for level in empty] == [0, 0, 0, 0]


@pytest.mark.usefixtures("tools")
def test_writes_every_level_from_the_decoded_pcm(wire: Wire, clips: dict[str, Path], tmp_path: Path) -> None:
    out = tmp_path / "peaks" / "abc"
    reply = wire.call("media.peaks", {"jobId": "p1", "path": str(clips["mp4_30"]), "outputDir": str(out)})
    result = reply["result"]
    assert result["audio"] is True and result["sampleRate"] == 48_000
    assert [level["samplesPerPeak"] for level in result["levels"]] == LEVELS
    index = json.loads((out / "index.json").read_text())
    assert index["version"] == 1 and index["levels"] == result["levels"]
    pcm = _pcm(clips["mp4_30"])
    assert index["durationSamples"] == len(pcm)
    lsb = 1 / 32768
    for samples_per_peak in LEVELS:
        reference = peaks.bucket_peaks(pcm, samples_per_peak)
        assert np.max(np.abs(_read_level(out, samples_per_peak) - reference)) <= lsb
    progress = [m["params"]["progress"] for m in wire.messages if m.get("method") == "progress" and m["params"]["jobId"] == "p1"]
    assert progress and progress[0] == 0 and all(0 <= value <= 1 for value in progress)
    assert sorted(path.name for path in out.iterdir()) == sorted(["index.json", *(f"{n}.f32" for n in LEVELS)])


@pytest.mark.usefixtures("tools")
def test_no_audio_stream_writes_a_marker(wire: Wire, clips: dict[str, Path], tmp_path: Path) -> None:
    out = tmp_path / "peaks" / "silent-video"
    result = wire.call("media.peaks", {"jobId": "p2", "path": str(clips["mp4_2997"]), "outputDir": str(out)})["result"]
    assert result == {"audio": False, "sampleRate": 48_000, "levels": []}
    assert json.loads((out / "index.json").read_text())["audio"] is False
    assert [path.name for path in out.iterdir()] == ["index.json"]


@pytest.mark.usefixtures("tools")
def test_rejects_levels_that_do_not_nest(wire: Wire, clips: dict[str, Path], tmp_path: Path) -> None:
    error = wire.call(
        "media.peaks", {"jobId": "p3", "path": str(clips["mp4_30"]), "outputDir": str(tmp_path), "levels": [256, 1000]}
    )["error"]
    assert error["code"] == rpc.INVALID_PARAMS


@pytest.mark.usefixtures("tools")
def test_cancel_stops_the_decode_and_leaves_no_final_file(wire: Wire, tmp_path: Path) -> None:
    source = tmp_path / "long.flac"
    assert FFMPEG is not None
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "anoisesrc=d=1200:r=48000", "-c:a", "flac", str(source)], check=True
    )
    out = tmp_path / "peaks" / "cancel"
    request = wire.request("media.peaks", {"jobId": "p4", "path": str(source), "outputDir": str(out)})
    wire.wait_for(lambda m: m.get("method") == "progress" and m["params"]["jobId"] == "p4" and m["params"]["progress"] > 0)
    assert wire.call("job.cancel", {"jobId": "p4"})["result"] == {"cancelled": True}
    assert wire.reply(request, timeout=1)["error"]["code"] == rpc.CANCELLED
    assert list(out.iterdir()) == []


@pytest.mark.usefixtures("tools")
def test_unwritable_output_fails_with_a_clear_error(wire: Wire, clips: dict[str, Path], tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a folder")
    error = wire.call("media.peaks", {"jobId": "p5", "path": str(clips["mp4_30"]), "outputDir": str(blocker / "x")})["error"]
    assert error["code"] == rpc.OUTPUT_ERROR
    assert str(tmp_path) not in error["message"]
