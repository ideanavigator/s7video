# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Import-time engine methods: keyframe gaps, thumbnails and preview proxies (S7V-025)."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from engine_support import FFMPEG, FFPROBE, Wire, make_clip

from s7engine import rpc


def _has_videotoolbox() -> bool:
    if FFMPEG is None:
        return False
    encoders = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return "h264_videotoolbox" in encoders


needs_videotoolbox = pytest.mark.skipif(not _has_videotoolbox(), reason="needs FFmpeg with h264_videotoolbox")


@pytest.fixture(scope="session")
def gop_clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    if FFMPEG is None or FFPROBE is None:
        pytest.skip("needs ffmpeg and ffprobe")
    root = tmp_path_factory.mktemp("gop")
    mpeg4 = ["-c:v", "mpeg4", "-q:v", "5", "-sc_threshold", "1000000000"]
    return {
        # 6 s at 30 fps with a keyframe every 10 s: one keyframe in the whole file.
        "long": make_clip(root / "long-gop.mp4", "testsrc2=s=640x360:r=30:d=6", [*mpeg4, "-g", "300"]),
        "short": make_clip(root / "short-gop.mp4", "testsrc2=s=640x360:r=30:d=6", [*mpeg4, "-g", "15"]),
        # Starts 1.5 s into its timeline, as camera files often do, and is portrait.
        "offset": make_clip(
            root / "offset.mp4",
            "testsrc2=s=360x640:r=30000/1001:d=3",
            [*mpeg4, "-g", "300", "-output_ts_offset", "1.5"],
        ),
        # Frame n is grey of luma 16 + 3n, so a decoded thumbnail names its own frame.
        "grey": make_clip(
            root / "grey.mp4",
            "color=c=black:s=640x360:r=30:d=2,format=gray,geq=lum='16+3*N',format=yuv420p",
            [*mpeg4, "-q:v", "2", "-g", "1"],
        ),
    }


def _video_pts(path: Path) -> list[int]:
    assert FFPROBE is not None
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts", "-of", "csv=p=0", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return sorted(int(line) for line in out.split() if line.strip())


def _luma(image: str) -> float:
    assert FFMPEG is not None
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", image, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return sum(raw) / len(raw)


def _proxy_params(wire: Wire, source: Path, output: Path, job_id: str) -> dict[str, object]:
    video = wire.call("media.probe", {"path": str(source)})["result"]["video"]
    return {
        "jobId": job_id,
        "path": str(source),
        "outputPath": str(output),
        "rate": video["frameRate"],
        "timeBase": video["timeBase"],
        "durationFrames": video["durationFrames"],
        "color": {key: value for key, value in video["color"].items() if value is not None},
    }


@pytest.mark.usefixtures("tools")
def test_keyframes_reports_the_longest_gap(wire: Wire, gop_clips: dict[str, Path]) -> None:
    long = wire.call("media.keyframes", {"path": str(gop_clips["long"])})["result"]
    short = wire.call("media.keyframes", {"path": str(gop_clips["short"])})["result"]
    tick = long["timeBase"]
    # One keyframe in 6 s: the gap is the whole scanned stretch, about 6 s.
    assert long["keyframes"] == 1
    assert long["maxGapTicks"] * tick["num"] / tick["den"] > 5.5
    assert short["keyframes"] >= 12
    assert short["maxGapTicks"] * short["timeBase"]["num"] / short["timeBase"]["den"] == pytest.approx(0.5, abs=0.04)
    assert all(isinstance(value, int) for value in (long["maxGapTicks"], long["scannedTicks"]))


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize("frame", [0, 30, 59])
def test_thumbnail_is_the_requested_frame_and_small(
    wire: Wire, gop_clips: dict[str, Path], tmp_path: Path, frame: int
) -> None:
    output = tmp_path / "thumbs" / "x.jpg"
    reply = wire.call(
        "media.thumbnail",
        {"path": str(gop_clips["grey"]), "outputPath": str(output), "frame": frame, "rate": {"num": 30, "den": 1}},
    )
    assert reply["result"] == {"path": str(output)}
    assert output.read_bytes()[:2] == b"\xff\xd8"
    assert _luma(str(output)) == pytest.approx(16 + 3 * frame, abs=3)
    assert list(output.parent.glob("*.part")) == []


@pytest.mark.usefixtures("tools")
def test_thumbnail_refuses_a_relative_output(wire: Wire, gop_clips: dict[str, Path]) -> None:
    reply = wire.call(
        "media.thumbnail",
        {"path": str(gop_clips["grey"]), "outputPath": "x.jpg", "frame": 0, "rate": {"num": 30, "den": 1}},
    )
    assert reply["error"]["code"] == rpc.INVALID_PARAMS


@needs_videotoolbox
@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize("clip", ["long", "offset"])
def test_proxy_keeps_every_source_timestamp(
    wire: Wire, gop_clips: dict[str, Path], tmp_path: Path, clip: str
) -> None:
    source = gop_clips[clip]
    before = (source.read_bytes(), os.stat(source).st_mtime_ns)
    output = tmp_path / "proxies" / f"{clip}.mp4"
    reply = wire.call("media.proxy", _proxy_params(wire, source, output, f"proxy-{clip}"))
    assert reply["result"] == {"path": str(output)}
    assert _video_pts(output) == _video_pts(source)
    src_video = wire.call("media.probe", {"path": str(source)})["result"]["video"]
    proxy_video = wire.call("media.probe", {"path": str(output)})["result"]["video"]
    assert proxy_video["codec"] == "h264"
    assert (proxy_video["firstPts"], proxy_video["frameCount"]) == (src_video["firstPts"], src_video["frameCount"])
    assert proxy_video["timeBase"] == src_video["timeBase"]
    # Smaller sources are never scaled up; the aspect stays the same.
    assert (proxy_video["width"], proxy_video["height"]) == (src_video["width"], src_video["height"])
    keyframes = wire.call("media.keyframes", {"path": str(output)})["result"]
    assert keyframes["maxGapTicks"] * keyframes["timeBase"]["num"] / keyframes["timeBase"]["den"] <= 0.6
    progress = [m for m in wire.messages if m.get("method") == "progress" and m["params"]["jobId"] == f"proxy-{clip}"]
    assert progress and all(0 <= m["params"]["progress"] <= 1 for m in progress)
    assert list(output.parent.glob("*.part")) == []
    assert (source.read_bytes(), os.stat(source).st_mtime_ns) == before


@needs_videotoolbox
@pytest.mark.usefixtures("tools")
def test_cancelled_proxy_leaves_no_partial_file(wire: Wire, gop_clips: dict[str, Path], tmp_path: Path) -> None:
    output = tmp_path / "proxies" / "cancelled.mp4"
    request = wire.request("media.proxy", _proxy_params(wire, gop_clips["long"], output, "proxy-cancel"))
    wire.wait_for(lambda m: m.get("method") == "progress" and m["params"]["jobId"] == "proxy-cancel")
    assert wire.call("job.cancel", {"jobId": "proxy-cancel"})["result"] == {"cancelled": True}
    assert wire.reply(request)["error"]["code"] == rpc.CANCELLED
    assert not output.exists()
    assert list(output.parent.glob("*.part")) == []


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize("kind", ["empty", "truncated"])
def test_unreadable_files_fail_with_a_plain_message(
    wire: Wire, gop_clips: dict[str, Path], tmp_path: Path, kind: str
) -> None:
    broken = tmp_path / f"{kind}.mp4"
    data = gop_clips["short"].read_bytes()
    broken.write_bytes(b"" if kind == "empty" else data[: len(data) // 3])
    for method in ("media.probe", "media.keyframes"):
        error = wire.call(method, {"path": str(broken)})["error"]
        assert error["code"] == rpc.MEDIA_ERROR
        assert str(tmp_path) not in error["message"]
