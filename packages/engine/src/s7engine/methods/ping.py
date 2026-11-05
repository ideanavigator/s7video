# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`engine.ping`: liveness, and the Python PID so the server can check it reaped the whole group."""

from __future__ import annotations

import os
from typing import Any

from ..jobs import JobContext
from ..rpc import PROTOCOL_VERSION, Method


def _ping(_params: dict[str, Any], _job: JobContext) -> dict[str, Any]:
    return {"pong": True, "protocol": PROTOCOL_VERSION, "pid": os.getpid()}


METHOD = Method(
    "engine.ping",
    _ping,
    {"type": "object", "additionalProperties": False, "properties": {}},
    # The server's health check: it must answer even while every worker runs a long job.
    inline=True,
)
