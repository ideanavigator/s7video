# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.thumbnail`: one small JPEG of a video frame, written to the caller's output path.

The frame is chosen by number at the caller's rate, counted from the video's first frame, the same
way `media.frame` counts. The file appears complete or not at all.
"""

from __future__ import annotations

import os
import threading
from typing import Any

from .. import timebase
from ..ffmpeg import run_tool
from ..jobs import JobContext
from ..rpc import INVALID_PARAMS, MEDIA_ERROR, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, RATE_SCHEMA, media_file
from .frame import _source_key, _video_offset


def _thumbnail(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    output = params["outputPath"]
    frame = params["frame"]
    rate = timebase.from_rational(params["rate"])
    max_width = params.get("maxWidth", 320)
    if not os.path.isabs(output):
        raise RpcError(INVALID_PARAMS, "invalid params at outputPath: must be absolute")
    stat = media_file(path)
    try:
        os.makedirs(os.path.dirname(output), exist_ok=True)
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the output folder cannot be created") from None
    seek = _video_offset(path, _source_key(path, stat), job) + timebase.frame_seek_seconds(frame, rate)
    partial = f"{output}.{os.getpid()}.{threading.get_ident()}.part"
    job.track_output(partial)
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
            "-vf",
            f"scale=w='min(iw,{max_width})':h=-2",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "-q:v",
            "5",
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
    os.replace(partial, output)
    job.keep_output(partial)
    return {"path": output}


METHOD = Method(
    "media.thumbnail",
    _thumbnail,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["path", "outputPath", "frame", "rate"],
        "properties": {
            "path": PATH_SCHEMA,
            "outputPath": PATH_SCHEMA,
            "frame": {"type": "integer", "minimum": 0, "maximum": 100_000_000},
            "rate": RATE_SCHEMA,
            "maxWidth": {"type": "integer", "minimum": 16, "maximum": 1920},
        },
    },
)
