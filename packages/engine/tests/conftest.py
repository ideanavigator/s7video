# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from engine_support import FFMPEG, FFPROBE, Wire, make_clip

@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch) -> None:
    if FFMPEG is None or FFPROBE is None:
        pytest.skip("needs ffmpeg and ffprobe")
    monkeypatch.setenv("S7_FFMPEG", FFMPEG)
    monkeypatch.setenv("S7_FFPROBE", FFPROBE)

@pytest.fixture(scope="session")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    if FFMPEG is None or FFPROBE is None:
        pytest.skip("needs ffmpeg and ffprobe")
    root = tmp_path_factory.mktemp("clips")
    return {
        # Frame n is a flat grey of luma 16 + 3n, so a decoded frame names its own number.
        "grey": make_clip(
            root / "grey.mkv",
            "color=c=black:s=64x64:r=30:d=2,format=gray,geq=lum='16+3*N'",
            ["-c:v", "ffv1", "-pix_fmt", "gray"],
        ),
        "mp4_30": make_clip(
            root / "testsrc2-30.mp4",
            "testsrc2=s=320x240:r=30:d=3",
            ["-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac", "-shortest"],
        ),
        "mp4_2997": make_clip(
            root / "testsrc2-2997.mp4",
            "testsrc2=s=320x240:r=30000/1001:d=2",
            ["-c:v", "mpeg4", "-q:v", "4"],
        ),
    }

@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> Iterator[Wire]:
    monkeypatch.setenv("S7_ENGINE_TEST_METHODS", "1")
    engine = Wire()
    yield engine
    engine.close()
