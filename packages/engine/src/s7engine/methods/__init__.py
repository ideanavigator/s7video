# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""The engine's JSON-RPC methods."""

from __future__ import annotations

import os

from ..rpc import Method
from . import frame, ping, probe


def all_methods() -> list[Method]:
    methods = [ping.METHOD, probe.METHOD, frame.METHOD]
    # Crash, hang and slow-job hooks for the server's supervision tests; never set in the app.
    if os.environ.get("S7_ENGINE_TEST_METHODS") == "1":
        from . import testing

        methods.extend(testing.METHODS)
    return methods
