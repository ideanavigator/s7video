# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest
from conftest import FFMPEG, Wire

from s7engine import rpc


def _floats(value: Any, where: str = "result") -> list[str]:
    if isinstance(value, float):
        return [where]
    if isinstance(value, dict):
        return [found for key, item in value.items() for found in _floats(item, f"{where}.{key}")]
    if isinstance(value, list):
        return [found for index, item in enumerate(value) for found in _floats(item, f"{where}[{index}]")]
    return []


def _luma(png: str) -> float:
    assert FFMPEG is not None
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return sum(raw) / len(raw)


@pytest.mark.usefixtures("tools")
def test_probe_reports_rationals_and_integer_frames(wire: Wire, clips: dict[str, Path]) -> None:
    result = wire.call("media.probe", {"path": str(clips["mp4_30"])})["result"]
    assert _floats(result) == []
    video = result["video"]
    assert video["frameRate"] == {"num": 30, "den": 1}
    assert video["variableFrameRate"] is False
    assert (video["width"], video["height"]) == (320, 240)
    assert video["frameCount"] == 90
    assert video["durationFrames"] == result["durationFrames"] == 90
    assert video["lastPts"] > video["firstPts"]
    assert result["audio"]["sampleRate"] == 48000
    assert result["audio"]["durationSamples"] == pytest.approx(144000, abs=1024)


@pytest.mark.usefixtures("tools")
def test_probe_ntsc_rate_and_counted_frames(wire: Wire, clips: dict[str, Path]) -> None:
    ntsc = wire.call("media.probe", {"path": str(clips["mp4_2997"])})["result"]["video"]
    assert ntsc["frameRate"] == {"num": 30000, "den": 1001}
    assert ntsc["durationFrames"] == ntsc["frameCount"] == 60
    # Matroska has no frame count in its header, so the engine counts packets.
    grey = wire.call("media.probe", {"path": str(clips["grey"])})["result"]
    assert grey["video"]["frameCount"] == grey["durationFrames"] == 60
    assert grey["audio"] is None


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize("frame", [0, 1, 17, 30, 59])
def test_frame_is_exactly_the_requested_frame(wire: Wire, clips: dict[str, Path], tmp_path: Path, frame: int) -> None:
    reply = wire.call(
        "media.frame",
        {"path": str(clips["grey"]), "frame": frame, "rate": {"num": 30, "den": 1}, "outputDir": str(tmp_path)},
    )
    result = reply["result"]
    assert result["path"].startswith(str(tmp_path)) and result["path"].endswith(".png")
    assert (result["width"], result["height"]) == (64, 64)
    assert _luma(result["path"]) == pytest.approx(16 + 3 * frame, abs=1)
    assert list(tmp_path.glob("*.part")) == []


@pytest.mark.usefixtures("tools")
def test_frame_scales_reuses_and_refuses_past_the_end(wire: Wire, clips: dict[str, Path], tmp_path: Path) -> None:
    params = {"path": str(clips["mp4_30"]), "frame": 45, "rate": {"num": 30, "den": 1}, "outputDir": str(tmp_path)}
    small = wire.call("media.frame", {**params, "maxWidth": 160})["result"]
    assert (small["width"], small["height"]) == (160, 120)
    again = wire.call("media.frame", {**params, "maxWidth": 160})["result"]
    assert again["path"] == small["path"]
    past = wire.call("media.frame", {**params, "frame": 5000})
    assert past["error"] == {"code": rpc.MEDIA_ERROR, "message": "the frame is past the end of the video"}
    assert list(tmp_path.glob("*.part")) == []


def test_media_errors_are_fixed_messages(wire: Wire, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    missing = wire.call("media.probe", {"path": str(tmp_path / "nope.mp4")})
    assert missing["error"] == {"code": rpc.FILE_NOT_FOUND, "message": "file not found"}
    relative = wire.call("media.probe", {"path": "clip.mp4"})
    assert relative["error"]["code"] == rpc.INVALID_PARAMS
    text = tmp_path / "notes.txt"
    text.write_text("not a video")
    monkeypatch.delenv("S7_FFPROBE", raising=False)
    no_tool = wire.call("media.probe", {"path": str(text)})
    assert no_tool["error"] == {"code": rpc.MISSING_TOOL, "message": "ffprobe is not available", "data": {"tool": "ffprobe"}}


@pytest.mark.usefixtures("tools")
def test_unreadable_media_is_a_media_error(wire: Wire, tmp_path: Path) -> None:
    text = tmp_path / "notes.mp4"
    text.write_text("not a video")
    reply = wire.call("media.probe", {"path": str(text)})
    assert reply["error"] == {"code": rpc.MEDIA_ERROR, "message": "ffprobe could not read the media"}
