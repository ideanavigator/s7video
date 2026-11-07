# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.filmstrip`: sprite sheets of small frames, one set per zoom level (S7V-035).

The clips here are grey frames whose luma names their own frame number, so a tile cut out of a
sheet says which frame it shows.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import numpy as np
import pytest
from engine_support import FFMPEG, Wire, make_clip

from s7engine import rpc
from s7engine.jobs import JobContext
from s7engine.methods import filmstrip

LUMA_STEP = 2


def _counter_clip(path: Path, rate: str, seconds: int, extra: list[str] | None = None) -> Path:
    # Frame n has luma 16 + 2n (up to 100 frames), as 4:2:0 so the sheet scaler sees real video.
    return make_clip(
        path,
        f"color=c=black:s=160x90:r={rate}:d={seconds},format=gray,geq=lum='16+{LUMA_STEP}*N',format=yuv420p",
        [*(extra or []), "-c:v", "mpeg4", "-q:v", "1", "-g", "10"],
    )


def _tile_luma(sheet: Path, row: int, column: int, width: int, height: int) -> float:
    assert FFMPEG is not None
    raw = subprocess.run(
        [
            FFMPEG,
            "-v",
            "error",
            "-i",
            str(sheet),
            "-vf",
            f"crop={width - 8}:{height - 8}:{column * width + 4}:{row * height + 4},format=gray",
            "-f",
            "rawvideo",
            "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return float(np.frombuffer(raw, dtype=np.uint8).mean())


def _run(wire: Wire, source: Path, out: Path, job: str, rate: dict[str, int], **extra: object) -> dict:
    reply = wire.call(
        "media.filmstrip", {"jobId": job, "path": str(source), "outputDir": str(out), "rate": rate, **extra}
    )
    assert "result" in reply, reply
    return reply["result"]


def test_tile_position_maps_frames_to_sheets() -> None:
    assert filmstrip.tile_position(0) == (1, 0, 0)
    assert filmstrip.tile_position(9) == (1, 0, 9)
    assert filmstrip.tile_position(10) == (1, 1, 0)
    assert filmstrip.tile_position(99) == (1, 9, 9)
    assert filmstrip.tile_position(100) == (2, 0, 0)
    assert filmstrip.tile_position(7, columns=3, rows=2) == (2, 0, 1)


@pytest.mark.usefixtures("tools")
def test_every_tile_shows_the_frame_its_index_names(wire: Wire, tmp_path: Path) -> None:
    source = _counter_clip(tmp_path / "counter.mp4", "10", 10)
    out = tmp_path / "filmstrip" / "abc"
    result = _run(wire, source, out, "f1", {"num": 10, "den": 1}, levels=[1, 4, 16])
    assert [level["level"] for level in result["levels"]] == ["16s", "4s", "1s"]
    index = json.loads((out / "index.json").read_text())
    assert index["version"] == 1 and (index["tileWidth"], index["tileHeight"]) == (160, 90)
    frames = {level["level"]: level["frames"] for level in index["levels"]}
    assert frames == {"16s": [0], "4s": [0, 40, 80], "1s": [10 * n for n in range(10)]}
    for level in index["levels"]:
        for tile, frame in enumerate(level["frames"]):
            sheet, row, column = filmstrip.tile_position(tile)
            luma = _tile_luma(out / level["sheets"][sheet - 1], row, column, 160, 90)
            assert abs(luma - (16 + LUMA_STEP * frame)) < 1.5, (level["level"], tile, frame, luma)
    names = sorted(path.name for path in out.iterdir())
    assert names == ["16s-1.jpg", "1s-1.jpg", "4s-1.jpg", "index.json"]
    progress = [m["params"]["progress"] for m in wire.messages if m.get("method") == "progress" and m["params"]["jobId"] == "f1"]
    assert progress and progress[0] == 0


@pytest.mark.usefixtures("tools")
def test_long_levels_fill_more_than_one_sheet(wire: Wire, tmp_path: Path) -> None:
    source = _counter_clip(tmp_path / "long.mp4", "1", 130)
    out = tmp_path / "filmstrip" / "long"
    result = _run(wire, source, out, "f2", {"num": 1, "den": 1}, levels=[1])
    assert result["levels"][0]["sheets"] == ["1s-1.jpg", "1s-2.jpg"]
    assert result["levels"][0]["count"] == 130


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize(("rate", "fraction"), [("30000/1001", (30000, 1001)), ("24000/1001", (24000, 1001))])
def test_odd_frame_rates_index_correctly(wire: Wire, tmp_path: Path, rate: str, fraction: tuple[int, int]) -> None:
    source = _counter_clip(tmp_path / "odd.mp4", rate, 3, ["-output_ts_offset", "1.5"])
    out = tmp_path / "filmstrip" / "odd"
    _run(wire, source, out, "f3", {"num": fraction[0], "den": fraction[1]}, levels=[1])
    frames = json.loads((out / "index.json").read_text())["levels"][0]["frames"]
    # The first frame at or after each whole second from the first frame: ceil(k * rate).
    per_second = fraction[0] / fraction[1]
    assert frames == [int(np.ceil(k * per_second - 1e-9)) for k in range(3)]


@pytest.mark.usefixtures("tools")
def test_vfr_frames_come_from_their_real_pts(wire: Wire, tmp_path: Path) -> None:
    # 30 fps for the first 40 frames, then every frame 13 ms late, as phone footage drifts.
    source = _counter_clip(
        tmp_path / "vfr.mp4",
        "30",
        3,
        ["-vf", "setpts='N/30/TB+if(gt(N,40),0.013*(N-40)/TB,0)'", "-fps_mode", "passthrough"],
    )
    out = tmp_path / "filmstrip" / "vfr"
    _run(wire, source, out, "f4", {"num": 30, "den": 1}, levels=[1])
    index = json.loads((out / "index.json").read_text())
    frames = index["levels"][0]["frames"]
    # Decoded frame 30 sits at 1 s; the frame shown at 2 s is decoded frame ~55, whose PTS is
    # frame 60 at 30 fps. The index names the frame position on the clock, not the decode count.
    assert frames[0] == 0 and frames[1] == 30
    assert 59 <= frames[2] <= 61


@pytest.mark.usefixtures("tools")
def test_audio_only_media_is_refused(wire: Wire, tmp_path: Path) -> None:
    assert FFMPEG is not None
    source = tmp_path / "music.m4a"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=d=2", "-c:a", "aac", str(source)], check=True)
    error = wire.call(
        "media.filmstrip", {"jobId": "f5", "path": str(source), "outputDir": str(tmp_path / "fs"), "rate": {"num": 30, "den": 1}}
    )["error"]
    assert error["code"] == rpc.MEDIA_ERROR


@pytest.mark.usefixtures("tools")
def test_cancel_stops_ffmpeg_and_leaves_no_final_file(wire: Wire, tmp_path: Path) -> None:
    source = make_clip(tmp_path / "big.mp4", "testsrc2=s=1280x720:r=30:d=120", ["-c:v", "mpeg4", "-q:v", "8"])
    out = tmp_path / "filmstrip" / "cancel"
    request = wire.request(
        "media.filmstrip", {"jobId": "f6", "path": str(source), "outputDir": str(out), "rate": {"num": 30, "den": 1}}
    )
    wire.wait_for(lambda m: m.get("method") == "progress" and m["params"]["jobId"] == "f6" and m["params"]["progress"] > 0)
    assert wire.call("job.cancel", {"jobId": "f6"})["result"] == {"cancelled": True}
    assert wire.reply(request, timeout=1)["error"]["code"] == rpc.CANCELLED
    assert list(out.iterdir()) == []


@pytest.mark.usefixtures("tools")
def test_metadata_that_is_not_utf8_does_not_break_the_log(wire: Wire, tmp_path: Path) -> None:
    # FFmpeg prints tags as the file stores them: here a Latin-1 "café", which is not UTF-8.
    assert FFMPEG is not None
    source = tmp_path / "latin1.mkv"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=3", "-c:v", "mpeg4", "-metadata", b"title=caf\xe9", str(source)],
        check=True,
    )
    result = _run(wire, source, tmp_path / "filmstrip" / "latin1", "f7", {"num": 10, "den": 1}, levels=[1])
    assert result["levels"][0]["count"] == 3


def _fake_ffmpeg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, script: str) -> None:
    fake = tmp_path / "fake-ffmpeg"
    fake.write_text(f"#!/bin/sh\n{script}\n")
    fake.chmod(0o755)
    monkeypatch.setenv("S7_FFMPEG", str(fake))


@pytest.mark.usefixtures("tools")
def test_a_full_disk_mid_write_is_an_output_error_and_leaves_no_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _counter_clip(tmp_path / "clip.mp4", "10", 2)
    out = tmp_path / "filmstrip" / "full"
    out.mkdir(parents=True)
    (out / "index.json").write_text("old")
    # Writes part of a sheet into its output folder, then fails the way FFmpeg does on ENOSPC.
    _fake_ffmpeg(
        tmp_path,
        monkeypatch,
        'for last; do :; done; dir=$(dirname "$last"); printf x > "$dir/16s-1.jpg"\n'
        'echo "[image2 @ 0x1] Error writing: No space left on device" >&2; exit 1',
    )
    with pytest.raises(rpc.RpcError) as raised:
        filmstrip.METHOD.handler(
            {"path": str(source), "outputDir": str(out), "rate": {"num": 10, "den": 1}}, JobContext.detached()
        )
    assert raised.value.code == rpc.OUTPUT_ERROR
    assert "disk space" in raised.value.message
    # The old index is untouched and no staging folder or final-named sheet is left behind.
    assert sorted(path.name for path in out.iterdir()) == ["index.json"]


@pytest.mark.usefixtures("tools")
def test_ffmpeg_is_stopped_when_reading_its_log_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = _counter_clip(tmp_path / "clip.mp4", "10", 2)
    pid_file = tmp_path / "ffmpeg.pid"
    _fake_ffmpeg(
        tmp_path,
        monkeypatch,
        f'echo $$ > "{pid_file}"; echo "[showinfo@l1 @ 0x1] n: 0 pts: 1000000" >&2; exec sleep 30',
    )
    reported = JobContext.progress

    def broken(job: JobContext, value: float, stage: str | None = None) -> None:
        # The first report from FFmpeg's log fails, as any bug in the read loop could.
        if value > 0:
            raise RuntimeError("progress went wrong")
        reported(job, value, stage)

    monkeypatch.setattr(JobContext, "progress", broken)
    with pytest.raises(RuntimeError):
        filmstrip.METHOD.handler(
            {"path": str(source), "outputDir": str(tmp_path / "fs"), "rate": {"num": 10, "den": 1}}, JobContext.detached()
        )
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
