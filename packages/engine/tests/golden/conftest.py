# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""pytest fixtures for the golden media tests: ``media`` (fetched clips) and ``synth_clip``."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest

import harness


@pytest.fixture
def media() -> Callable[[str], Path]:
    """``media("talking-head-01")`` is the cached clip's path; the test skips when it is absent."""

    def resolve(clip_id: str) -> Path:
        path = harness.cached_clip(clip_id)
        if path is None:
            pytest.skip(f"{clip_id} is not in {harness.media_dir()}: {harness.FETCH_HINT}")
        return path

    return resolve


@pytest.fixture
def synth_clip() -> Callable[[dict], Path]:
    """``synth_clip(spec)`` generates (or reuses) a synthetic clip from fixtures/media/synth.ts."""
    return harness.synth
