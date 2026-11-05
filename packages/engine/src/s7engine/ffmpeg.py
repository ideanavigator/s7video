# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""FFmpeg and ffprobe, by the absolute paths the server passes in `S7_FFMPEG` and `S7_FFPROBE`.

The engine never searches PATH for them: the server resolves them and starts the engine with an
explicit environment. Tool output stays in the engine; errors carry fixed messages only.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

from .jobs import Cancelled, JobContext
from .rpc import MEDIA_ERROR, MISSING_TOOL, RpcError

_ENV = {"ffmpeg": "S7_FFMPEG", "ffprobe": "S7_FFPROBE"}


def tool_path(tool: str) -> str:
    path = os.environ.get(_ENV[tool], "")
    if not path or not os.path.isabs(path) or not os.access(path, os.X_OK):
        raise RpcError(MISSING_TOOL, f"{tool} is not available", {"tool": tool})
    return path


# Per tool run, under the server's 30 s quick-call timeout, so one slow FFmpeg run fails with a
# reason. A method that runs several tools (a probe up to three, a frame two) can take longer in
# total; then the server's health ping, not this limit, decides whether the engine is hung.
# Long jobs pass their own limit.
QUICK_TOOL_TIMEOUT = 25.0


def run_tool(tool: str, args: list[str], job: JobContext, timeout: float = QUICK_TOOL_TIMEOUT) -> bytes:
    """Runs a tool to completion and returns its stdout; a cancelled job stops it at once."""
    process = subprocess.Popen(
        [tool_path(tool), *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_tool_env(),
    )
    stop = process.kill
    job.on_cancel(stop)
    try:
        stdout, _stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise RpcError(MEDIA_ERROR, f"{tool} took too long") from None
    finally:
        job.remove_on_cancel(stop)
    if job.cancelled:
        raise Cancelled()
    if process.returncode != 0:
        raise RpcError(MEDIA_ERROR, f"{tool} could not read the media")
    return stdout


def ffprobe_json(args: list[str], job: JobContext) -> dict[str, Any]:
    output = run_tool("ffprobe", ["-v", "error", "-of", "json", *args], job)
    try:
        parsed = json.loads(output)
    except ValueError:
        raise RpcError(MEDIA_ERROR, "ffprobe returned unreadable output") from None
    if not isinstance(parsed, dict):
        raise RpcError(MEDIA_ERROR, "ffprobe returned unreadable output")
    return parsed


def _tool_env() -> dict[str, str]:
    # The engine's own environment is already explicit; tools get only what they need.
    keep = ("PATH", "HOME", "TMPDIR", "LANG")
    return {key: os.environ[key] for key in keep if key in os.environ}
