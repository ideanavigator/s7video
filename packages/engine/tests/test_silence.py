# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`silence.detect`: per-frame sound levels on the transcript's frame clock (S7V-027)."""

from __future__ import annotations

import math
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest
from engine_support import Wire, make_clip

from s7engine.methods import silence
from s7engine.methods.transcribe import SAMPLE_RATE, FrameClock

RATE = Fraction(30)


def tone(seconds: float, dbfs: float) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (10 ** (dbfs / 20) * math.sqrt(2) * np.sin(2 * math.pi * 220 * t)).astype(np.float32)


def test_frame_levels_measure_each_frame() -> None:
    pcm = np.concatenate([tone(1, -12), np.zeros(SAMPLE_RATE, dtype=np.float32), tone(1, -30)])
    levels = silence.frame_levels(pcm, FrameClock(rate=RATE), 90)
    assert len(levels) == 90 and all(isinstance(level, int) for level in levels)
    assert set(levels[:30]) == {-12}
    assert set(levels[30:60]) == {silence.FLOOR_DB}
    assert set(levels[60:]) == {-30}


def test_frame_levels_follow_the_video_clock() -> None:
    # Sound that starts half a second after the first video frame: those frames have none.
    pcm = tone(1, -12)
    levels = silence.frame_levels(pcm, FrameClock(rate=RATE, audio_start=Fraction(1, 2)), 45)
    assert set(levels[:15]) == {silence.FLOOR_DB}
    assert set(levels[15:45]) == {-12}
    # Past the end of the sound reads as the floor, not as an error.
    assert silence.frame_levels(pcm, FrameClock(rate=RATE), 40)[30:] == [silence.FLOOR_DB] * 10
    assert silence.frame_levels(pcm, FrameClock(rate=RATE), 0) == []


@pytest.mark.usefixtures("tools")
def test_silence_detect_reads_a_clip(tmp_path: Path) -> None:
    # One second of tone, one of silence, at 29.97 fps: the rate the transcript uses.
    clip = make_clip(
        tmp_path / "beep.mp4",
        "testsrc2=s=64x64:r=30000/1001:d=2",
        [
            "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1,apad=pad_dur=1",
            "-c:v", "mpeg4", "-c:a", "aac", "-t", "2",
        ],
    )
    engine = Wire()
    try:
        reply = engine.call("silence.detect", {"path": str(clip)})
    finally:
        engine.close()
    result = reply["result"]
    assert result["rate"] == {"num": 30000, "den": 1001}
    assert result["durationFrames"] == len(result["levels"]) == 60
    assert max(result["levels"][2:27]) - min(result["levels"][2:27]) <= 1
    assert result["levels"][2] > -30
    assert max(result["levels"][34:58]) <= -80


def test_silence_detect_rejects_bad_params() -> None:
    engine = Wire()
    try:
        assert engine.call("silence.detect", {})["error"]["code"] == -32602
        assert engine.call("silence.detect", {"path": "relative.mp4"})["error"]["code"] == -32602
    finally:
        engine.close()
