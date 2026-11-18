# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.loudness`: a file's integrated loudness (EBU R128), to place sound relative to the voice (S7V-036).

``ebur128`` gates in 400 ms blocks, so a file shorter than one block has none and reads −70 LUFS.
A file under ``LOOP_SECONDS`` is looped to that length first: a looped sound's integrated loudness
is its loudness while it plays, the same as a long recording of it. Nothing above the −70 LUFS gate
gives ``None``. The server caches the answer by fingerprint (``.s7cache/loudness/``).
"""

from __future__ import annotations

import math
import re
from typing import Any

from ..ffmpeg import ffprobe_json, run_tool_output
from ..jobs import JobContext
from ..rpc import MEDIA_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, media_file
from .transcribe import NO_AUDIO

LOOP_SECONDS = 3.0
#: ``ebur128``'s absolute gate: an integrated value at or below it means no sound was measured.
GATE_LUFS = -70.0

_INTEGRATED = re.compile(r"Summary:.*?I:\s+(-?[0-9.]+|-inf)\s+LUFS", re.DOTALL)


def integrated_lufs(stderr: str) -> float | None:
    """The summary's integrated loudness; ``None`` for silence."""
    match = _INTEGRATED.search(stderr)
    if match is None:
        raise RpcError(MEDIA_ERROR, "the loudness measurement failed")
    value = float(match.group(1))
    return value if math.isfinite(value) and value > GATE_LUFS else None


def _duration(path: str, job: JobContext) -> float | None:
    info = ffprobe_json(["-show_entries", "format=duration:stream=codec_type", path], job)
    if not any(stream.get("codec_type") == "audio" for stream in info.get("streams") or []):
        raise RpcError(NO_AUDIO, "this file has no sound")
    try:
        return float((info.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        return None


def _loudness(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    media_file(path)
    seconds = _duration(path, job)
    loop = ["-stream_loop", "-1", "-t", str(LOOP_SECONDS)] if seconds is not None and seconds < LOOP_SECONDS else []
    _, stderr = run_tool_output(
        "ffmpeg",
        ["-nostdin", "-hide_banner", "-nostats", *loop, "-i", path, "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
        job,
    )
    return {"integratedLufs": integrated_lufs(stderr.decode(errors="replace"))}


METHOD = Method(
    "media.loudness",
    _loudness,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["path"],
        "properties": {"path": PATH_SCHEMA},
    },
)
