# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``engine-probe-frame``: the engine's ``media.probe`` and ``media.frame`` on real and
synthetic media (S7V-022).

- The probe summary matches the stored reference exactly, and agrees with the harness's own
  ffprobe packet count, rate, size and colour tags.
- Frame N, which the engine finds by seeking, matches frame N decoded independently from the start
  (FFmpeg ``select=eq(n,N)``): SSIM ≥ 0.98 and pHash distance ≤ 6. Its pHash is also within 6 of
  the stored reference. On the testsrc2 clip a neighbouring frame scores SSIM 0.93, so an
  off-by-one seek fails; the talking head barely moves between frames, so it guards the seek on
  real AV1 media rather than frame accuracy, which ``tests/test_media.py`` checks exactly.

The references are data (JSON), never images. A legitimate change (a new clip or recipe) is
recorded by running this file with ``S7VIDEO_GOLDEN_UPDATE=1`` and saying why in the PR.
Run with ``pnpm test:golden -- engine-probe-frame``.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

import harness
from s7engine.jobs import JobContext
from s7engine.methods import frame as frame_method
from s7engine.methods import probe as probe_method

REFERENCE = Path(__file__).parent / "references" / "engine-probe-frame.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
SSIM_MIN = 0.98
PHASH_MAX = 6

SYNTH_SPEC = {
    "name": "engine-probe-frame-30",
    "fps": "30/1",
    "width": 640,
    "height": 360,
    "audio": [{"seconds": 4, "toneHz": 440}],
}
# Frame numbers well past the first keyframe, so the engine has to seek and decode forward.
CASES = {"talking-head-01": 1200, "synth-testsrc2-30": 45}


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _engine_summary(probe: dict[str, Any]) -> dict[str, Any]:
    video, audio = probe["video"], probe["audio"]
    rate = video["frameRate"]
    return {
        "container": probe["container"],
        "durationFrames": probe["durationFrames"],
        "video": {
            "codec": video["codec"],
            "width": video["width"],
            "height": video["height"],
            "pixelFormat": video["pixelFormat"],
            "frameRate": f"{rate['num']}/{rate['den']}",
            "variableFrameRate": video["variableFrameRate"],
            "frameCount": video["frameCount"],
            "durationFrames": video["durationFrames"],
            "color": video["color"],
        },
        "audio": None
        if audio is None
        else {
            "codec": audio["codec"],
            "sampleRate": audio["sampleRate"],
            "channels": audio["channels"],
            "durationSamples": audio["durationSamples"],
        },
    }


def _decoded_frame(clip: Path, frame: int, out: Path) -> Path:
    """Frame ``frame`` by decoding every frame from the start: the engine's seek is not involved."""
    subprocess.run(
        [
            harness._tool("ffmpeg"),
            "-v",
            "error",
            "-i",
            str(clip),
            "-vf",
            f"select=eq(n\\,{frame})",
            "-frames:v",
            "1",
            "-y",
            str(out),
        ],
        check=True,
    )
    return out


def _check(case: str, clip: Path, tmp_path: Path) -> None:
    reference = json.loads(REFERENCE.read_text(encoding="utf-8")) if REFERENCE.exists() else {}
    job = JobContext.detached()
    probe = probe_method.METHOD.handler({"path": str(clip)}, job)
    summary = _engine_summary(probe)

    independent = harness.probe_summary(clip)
    assert summary["video"]["frameRate"] == independent["fps"]
    assert summary["video"]["frameCount"] == independent["video_frames"]
    assert summary["durationFrames"] == independent["duration_frames"]
    assert (summary["video"]["width"], summary["video"]["height"]) == (
        independent["width"],
        independent["height"],
    )
    for tag in ("range", "space", "transfer", "primaries"):
        assert summary["video"]["color"][tag] == independent[f"color_{tag}"]

    n = CASES[case]
    grabbed = frame_method.METHOD.handler(
        {"path": str(clip), "frame": n, "rate": probe["video"]["frameRate"], "outputDir": str(tmp_path)},
        job,
    )
    engine_png = Path(grabbed["path"])
    decoded_png = _decoded_frame(clip, n, tmp_path / f"decoded-{n}.png")
    score = harness.ssim(decoded_png, engine_png)
    engine_hash = harness.phash(engine_png)
    assert score.min >= SSIM_MIN, f"{case} frame {n}: SSIM {score.min:.4f} vs independent decode"
    assert harness.phash_distance(engine_hash, harness.phash(decoded_png)) <= PHASH_MAX

    record = {"frame": n, "summary": summary, "framePhash": f"{engine_hash:016x}"}
    if UPDATE:
        reference[case] = record
        REFERENCE.write_text(json.dumps(reference, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return
    expected = reference[case]
    assert summary == expected["summary"]
    assert expected["frame"] == n
    distance = harness.phash_distance(engine_hash, int(expected["framePhash"], 16))
    assert distance <= PHASH_MAX, f"{case} frame {n}: pHash distance {distance} from the reference"


def test_talking_head_probe_and_frame(media, tmp_path: Path) -> None:
    _check("talking-head-01", media("talking-head-01"), tmp_path)


def test_synthetic_testsrc2_probe_and_frame(synth_clip, tmp_path: Path) -> None:
    _check("synth-testsrc2-30", synth_clip(SYNTH_SPEC), tmp_path)
