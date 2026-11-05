# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Preview proxies for footage the player seeks badly (spike A2).

`media.keyframes` reads packet flags (no decoding) over the first stretch of the video and reports
the longest gap between keyframes. `media.proxy` is a job that writes a short-GOP H.264 copy at
most 1920 px on its long side. It keeps every source timestamp (`-copyts`, passthrough frame
timing, the source time base), so frame N of the proxy is frame N of the original.
"""

from __future__ import annotations

import os
import subprocess
from fractions import Fraction
from typing import Any

from .. import timebase
from ..ffmpeg import _tool_env, ffprobe_json, tool_path
from ..jobs import Cancelled, JobContext
from ..rpc import INVALID_PARAMS, MEDIA_ERROR, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, RATE_SCHEMA, media_file

# Enough to judge a 2 s keyframe threshold: one keyframe in 10 s is a 10 s gap. Reading packet
# flags of 10 s of 110 Mbit/s 4K is ~140 MB, which keeps import fast.
_SCAN_SECONDS = 10
_PROXY_LONG_SIDE = 1920


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _keyframes(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    media_file(path)
    info = ffprobe_json(
        [
            "-select_streams",
            "v:0",
            "-read_intervals",
            f"%+{_SCAN_SECONDS}",
            "-show_entries",
            "stream=time_base:packet=pts,flags",
            path,
        ],
        job,
    )
    streams = info.get("streams") or []
    time_base = timebase.parse_rational(streams[0].get("time_base")) if streams else None
    if time_base is None:
        raise RpcError(MEDIA_ERROR, "the file has no video")
    packets = [
        (pts, "K" in str(packet.get("flags") or ""))
        for packet in info.get("packets") or []
        if (pts := _int(packet.get("pts"))) is not None
    ]
    if not packets:
        raise RpcError(MEDIA_ERROR, "the video stream has no frames")
    keys = sorted(pts for pts, key in packets if key)
    first, last = min(pts for pts, _ in packets), max(pts for pts, _ in packets)
    # Without a second keyframe in the window, the gap is at least the whole window.
    gaps = [later - earlier for earlier, later in zip(keys, keys[1:])]
    if len(keys) < 2:
        gaps.append(last - (keys[0] if keys else first))
    return {
        "timeBase": timebase.rational(time_base),
        "maxGapTicks": max(gaps),
        "keyframes": len(keys),
        "scannedTicks": last - first,
    }


def _scale_filter() -> str:
    side = _PROXY_LONG_SIDE
    # Landscape and portrait alike: the long side at most 1920, never upscaled, even dimensions.
    return (
        f"scale=w='if(gte(iw,ih),min(iw,{side}),-2)':h='if(gte(iw,ih),-2,min(ih,{side}))'"
        ":force_divisible_by=2"
    )


def _color_args(params: dict[str, Any]) -> list[str]:
    color = params.get("color") or {}
    flags = {"primaries": "-color_primaries", "transfer": "-color_trc", "space": "-colorspace", "range": "-color_range"}
    return [arg for key, flag in flags.items() if isinstance(color.get(key), str) for arg in (flag, color[key])]


def _proxy(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    output = params["outputPath"]
    if not os.path.isabs(output):
        raise RpcError(INVALID_PARAMS, "invalid params at outputPath: must be absolute")
    media_file(path)
    rate = timebase.from_rational(params["rate"])
    total = Fraction(params["durationFrames"]) / rate
    time_base = timebase.from_rational(params["timeBase"])
    try:
        os.makedirs(os.path.dirname(output), exist_ok=True)
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the output folder cannot be created") from None
    partial = f"{output}.{os.getpid()}.part"
    job.track_output(partial)
    job.progress(0, "proxy")
    args = [
        tool_path("ffmpeg"),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        _scale_filter(),
        "-c:v",
        "h264_videotoolbox",
        "-b:v",
        "8M",
        "-g",
        "15",
        "-pix_fmt",
        "yuv420p",
        *_color_args(params),
        "-fps_mode",
        "passthrough",
        "-copyts",
        "-enc_time_base:v",
        "demux",
        "-video_track_timescale",
        str(time_base.denominator) if time_base.numerator == 1 else "90000",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-y",
        partial,
    ]
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_tool_env(), text=True)
    stop = process.kill
    job.on_cancel(stop)
    try:
        assert process.stdout is not None
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            micros = _int(value) if key == "out_time_us" else None
            if micros is not None and total > 0 and not job.cancelled:
                job.progress(min(Fraction(micros, 1_000_000) / total, Fraction(99, 100)), "proxy")
        process.wait()
    finally:
        job.remove_on_cancel(stop)
    if job.cancelled:
        raise Cancelled()
    if process.returncode != 0 or not os.path.exists(partial) or os.path.getsize(partial) == 0:
        raise RpcError(MEDIA_ERROR, "the preview copy could not be made")
    os.replace(partial, output)
    job.keep_output(partial)
    return {"path": output}


_COLOR_FIELD = {"type": ["string", "null"], "maxLength": 64, "pattern": "^[A-Za-z0-9_-]*$"}

KEYFRAMES = Method(
    "media.keyframes",
    _keyframes,
    {"type": "object", "additionalProperties": False, "required": ["path"], "properties": {"path": PATH_SCHEMA}},
)

PROXY = Method(
    "media.proxy",
    _proxy,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["jobId", "path", "outputPath", "rate", "durationFrames", "timeBase"],
        "properties": {
            "jobId": {"type": "string"},
            "path": PATH_SCHEMA,
            "outputPath": PATH_SCHEMA,
            "rate": RATE_SCHEMA,
            "timeBase": RATE_SCHEMA,
            "durationFrames": {"type": "integer", "minimum": 1, "maximum": 100_000_000},
            "color": {
                "type": "object",
                "additionalProperties": False,
                "properties": {key: _COLOR_FIELD for key in ("primaries", "transfer", "space", "range")},
            },
        },
    },
    job=True,
)
