# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Supervision test hooks, registered only when `S7_ENGINE_TEST_METHODS=1`.

`test.slowJob` writes a partial file step by step with progress, so cancel can be checked;
`test.hang` never answers, for the server's timeout; `test.crash` exits the process mid-call.
"""

from __future__ import annotations

import os
from typing import Any

from ..jobs import JobContext
from ..rpc import Method
from ._media import PATH_SCHEMA


def _slow_job(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    output = params["outputPath"]
    steps = params.get("steps", 50)
    step_seconds = params.get("stepMs", 100) / 1000
    job.track_output(output)
    with open(output, "wb") as file:
        for step in range(steps):
            file.write(b"\0" * 1024)
            file.flush()
            job.progress((step + 1) / steps, "writing")
            if job.wait_cancelled(step_seconds):
                job.raise_if_cancelled()
    job.keep_output(output)
    return {"path": output, "steps": steps}


def _hang(_params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    job.wait_cancelled(3600)
    return {}


def _crash(_params: dict[str, Any], _job: JobContext) -> dict[str, Any]:
    os._exit(3)


METHODS = [
    Method(
        "test.slowJob",
        _slow_job,
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["jobId", "outputPath"],
            "properties": {
                "jobId": {"type": "string"},
                "outputPath": PATH_SCHEMA,
                "steps": {"type": "integer", "minimum": 1, "maximum": 10_000},
                "stepMs": {"type": "integer", "minimum": 1, "maximum": 10_000},
            },
        },
        job=True,
    ),
    Method("test.hang", _hang, {"type": "object"}),
    Method("test.crash", _crash, {"type": "object"}),
]
