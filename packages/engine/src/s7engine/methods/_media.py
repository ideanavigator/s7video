# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Shared checks for methods that read a media file."""

from __future__ import annotations

import os

from ..rpc import FILE_NOT_FOUND, INVALID_PARAMS, RpcError

PATH_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 4096}
RATE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["num", "den"],
    "properties": {
        "num": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
        "den": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
    },
}


def media_file(path: str) -> os.stat_result:
    if not os.path.isabs(path):
        raise RpcError(INVALID_PARAMS, "invalid params at path: must be absolute")
    try:
        stat = os.stat(path)
    except OSError:
        raise RpcError(FILE_NOT_FOUND, "file not found") from None
    if not os.path.isfile(path):
        raise RpcError(FILE_NOT_FOUND, "file not found")
    return stat
