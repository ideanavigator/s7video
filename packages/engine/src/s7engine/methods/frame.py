# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.frame`: one video frame, chosen by frame number at a given rate, written as a PNG file.

The PNG is returned as a path in the caller's output folder, never as bytes on the pipe. Frame
numbers count from the video stream's first frame, whatever the container's start time is.
"""

from __future__ import annotations

import hashlib
import os
import struct
import threading
from collections import OrderedDict
from fractions import Fraction
from typing import Any

from .. import timebase
from ..ffmpeg import ffprobe_json, run_tool
from ..jobs import JobContext
from ..rpc import INVALID_PARAMS, MEDIA_ERROR, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, RATE_SCHEMA, media_file

_OFFSETS: OrderedDict[str, Fraction] = OrderedDict()
_OFFSETS_LOCK = threading.Lock()
_OFFSETS_MAX = 256


def _source_key(path: str, stat: os.stat_result) -> str:
    identity = f"{os.path.realpath(path)}\0{stat.st_size}\0{stat.st_mtime_ns}"
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


def _video_offset(path: str, key: str, job: JobContext) -> Fraction:
    """Seconds from the container start (FFmpeg's `-ss` origin) to the first video frame."""
    with _OFFSETS_LOCK:
        if key in _OFFSETS:
            _OFFSETS.move_to_end(key)
            return _OFFSETS[key]
    info = ffprobe_json(
        ["-select_streams", "v:0", "-show_entries", "format=start_time:stream=start_pts,time_base", path],
        job,
    )
    streams = info.get("streams") or []
    if not streams:
        raise RpcError(MEDIA_ERROR, "the file has no video")
    time_base = timebase.parse_rational(streams[0].get("time_base"))
    try:
        container_start = Fraction((info.get("format") or {}).get("start_time") or "0")
        video_start = int(streams[0].get("start_pts") or 0) * (time_base or Fraction(0))
    except (TypeError, ValueError):
        container_start = video_start = Fraction(0)
    offset = max(Fraction(0), video_start - container_start)
    with _OFFSETS_LOCK:
        _OFFSETS[key] = offset
        while len(_OFFSETS) > _OFFSETS_MAX:
            _OFFSETS.popitem(last=False)
    return offset


def _png_size(path: str) -> tuple[int, int]:
    with open(path, "rb") as file:
        header = file.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise RpcError(OUTPUT_ERROR, "the frame image is unreadable")
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def _frame(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    frame = params["frame"]
    rate = timebase.from_rational(params["rate"])
    output_dir = params["outputDir"]
    max_width = params.get("maxWidth")
    if not os.path.isabs(output_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at outputDir: must be absolute")
    stat = media_file(path)
    key = _source_key(path, stat)
    name = f"{key}-f{frame}-r{rate.numerator}_{rate.denominator}-w{max_width or 0}.png"
    target = os.path.join(output_dir, name)
    if not os.path.exists(target):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except OSError:
            raise RpcError(OUTPUT_ERROR, "the output folder cannot be created") from None
        seek = _video_offset(path, key, job) + timebase.frame_seek_seconds(frame, rate)
        partial = f"{target}.{os.getpid()}.{threading.get_ident()}.part"
        job.track_output(partial)
        filters = [f"scale=w='min(iw,{max_width})':h=-2"] if max_width else []
        run_tool(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                timebase.decimal_seconds(seek),
                "-i",
                path,
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                *(["-vf", ",".join(filters)] if filters else []),
                "-f",
                "image2",
                "-c:v",
                "png",
                "-update",
                "1",
                "-y",
                partial,
            ],
            job,
        )
        if not os.path.exists(partial) or os.path.getsize(partial) == 0:
            job.discard_outputs()
            raise RpcError(MEDIA_ERROR, "the frame is past the end of the video")
        os.replace(partial, target)
        job.keep_output(partial)
    width, height = _png_size(target)
    return {"path": target, "frame": frame, "rate": timebase.rational(rate), "width": width, "height": height}


METHOD = Method(
    "media.frame",
    _frame,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["path", "frame", "rate", "outputDir"],
        "properties": {
            "path": PATH_SCHEMA,
            "frame": {"type": "integer", "minimum": 0, "maximum": 100_000_000},
            "rate": RATE_SCHEMA,
            "outputDir": PATH_SCHEMA,
            "maxWidth": {"type": "integer", "minimum": 16, "maximum": 8192},
        },
    },
)
