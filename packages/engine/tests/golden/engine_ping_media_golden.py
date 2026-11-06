# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``engine-ping-media``: the fetched clip probes exactly as the stored reference says.

Run with ``pnpm test:golden -- engine-ping-media``. A legitimate change (a new clip) regenerates
``references/engine-ping-media.json`` from ``harness.probe_summary`` and says why in the PR.
"""

import json
from pathlib import Path

import harness

REFERENCE = Path(__file__).parent / "references" / "engine-ping-media.json"


def test_talking_head_probe_matches_reference(media):
    clip = media("talking-head-01")
    assert harness.probe_summary(clip) == json.loads(REFERENCE.read_text(encoding="utf-8"))
