# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Captions already in the picture (S7V-099): what counts as captions, and Apple Vision on real frames."""

from __future__ import annotations

import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from engine_support import FFMPEG, make_clip

from s7engine import burned_in, captions_ass
from s7engine.jobs import JobContext

RATE = Fraction(30)
TEXTS = (
    "morning rivers carry golden light across quiet valleys where old stone bridges remember every "
    "traveller who paused to listen before walking home through tall green meadows full of bright summer flowers"
).split()


def _words() -> list[dict[str, Any]]:
    """Three words a second, 30 frames each second, in order."""
    return [{"text": text, "startFrame": index * 10, "endFrame": index * 10 + 9} for index, text in enumerate(TEXTS)]


def _caption_frames(words: list[dict[str, Any]], top: float = 0.7) -> tuple[list[list[burned_in.Line]], list[set[str]]]:
    """The lines a captioned clip shows at each sample: the three words said around it."""
    seconds = burned_in.sample_seconds(words, RATE)
    frames = []
    for at in seconds:
        index = min(int(at * 3), len(words) - 1) // 3 * 3
        text = " ".join(word["text"] for word in words[index : index + 3])
        frames.append([burned_in.Line(text.upper(), top, top + 0.05)])
    return frames, [burned_in.spoken_near(words, RATE, at) for at in seconds]


def test_lines_that_follow_the_speech_are_captions() -> None:
    frames, spoken = _caption_frames(_words())
    result = burned_in.assess(frames, spoken)
    assert result == {"found": True, "confidence": 1.0, "region": {"y0": 0.7, "y1": 0.75}}


def test_samples_sit_in_the_middle_of_spoken_words() -> None:
    words = _words()
    seconds = burned_in.sample_seconds(words, RATE)
    assert len(seconds) == burned_in.SAMPLES
    assert seconds[0] == pytest.approx(4.5 / 30) and seconds[-1] == pytest.approx((len(words) - 1) * 10 / 30 + 4.5 / 30)
    assert burned_in.sample_seconds(words[:4], RATE) == pytest.approx([(index * 10 + 4.5) / 30 for index in range(4)])
    assert burned_in.sample_seconds([], RATE) == []


def test_a_logo_or_sign_is_not_captions_even_when_said() -> None:
    """Static text that stays in the picture never counts, whatever the speaker says."""
    words = _words()
    seconds = burned_in.sample_seconds(words, RATE)
    spoken = [burned_in.spoken_near(words, RATE, at) for at in seconds]
    sign = [[burned_in.Line("Golden Rivers", 0.1, 0.15), burned_in.Line("OPEN", 0.9, 0.95)] for _ in seconds]
    assert burned_in.assess(sign, spoken) == {"found": False, "confidence": 0.0}
    # Text that has nothing to do with the speech is not captions either.
    shop = [[burned_in.Line(f"Shop sale {index} percent off", 0.5, 0.55)] for index in range(len(seconds))]
    assert burned_in.assess(shop, spoken)["found"] is False


def test_a_few_matching_frames_are_not_enough() -> None:
    frames, spoken = _caption_frames(_words())
    sparse = [lines if index < 3 else [] for index, lines in enumerate(frames)]
    assert burned_in.assess(sparse, spoken) == {"found": False, "confidence": 0.3}
    some = [lines if index < 4 else [] for index, lines in enumerate(frames)]
    assert burned_in.assess(some, spoken)["found"] is True


def test_one_letter_words_never_match() -> None:
    assert burned_in.tokens("I am a Bridge-builder, OK?") == ["am", "bridge", "builder", "ok"]
    words = [{"text": "I", "startFrame": index * 10, "endFrame": index * 10 + 9} for index in range(30)]
    seconds = burned_in.sample_seconds(words, RATE)
    frames = [[burned_in.Line(f"I {index}", 0.8, 0.85)] for index in range(len(seconds))]
    spoken = [burned_in.spoken_near(words, RATE, at) for at in seconds]
    assert burned_in.assess(frames, spoken)["found"] is False


# --- Apple Vision on real frames ----------------------------------------------------------------


@pytest.fixture
def vision(tools: None) -> None:
    if not burned_in.vision_available():
        pytest.skip("needs Apple Vision (pyobjc-framework-Vision on macOS)")


SOURCE = "color=c=0x3A4A5E:s=540x960:r=30:d=15"


def _burn(tmp_path: Path, plain: Path, words: list[dict[str, Any]]) -> Path:
    """The plain clip with our own captions burned in by FFmpeg and libass, as the export does."""
    assert FFMPEG is not None
    chunks = captions_ass.chunk_words([captions_ass.Word(w["text"], w["startFrame"], w["endFrame"]) for w in words], RATE)
    captions_ass.write_ass(tmp_path / "captions.ass", chunks, RATE, 540, 960)
    captions_ass.link_fonts(tmp_path / "fonts")
    burned = tmp_path / "burned.mkv"
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-i", str(plain), "-vf", "subtitles=filename=captions.ass:fontsdir=fonts",
         "-c:v", "ffv1", str(burned)],
        check=True,
        cwd=tmp_path,
    )
    return burned


@pytest.mark.usefixtures("vision")
def test_vision_finds_burned_in_captions_and_not_a_plain_or_signed_clip(tmp_path: Path) -> None:
    words = _words()
    plain = make_clip(tmp_path / "plain.mkv", SOURCE, ["-c:v", "ffv1"])
    burned = _burn(tmp_path, plain, words)
    font = captions_ass.FONTS_DIR / "Inter-Bold.ttf"
    signed = make_clip(
        tmp_path / "signed.mkv",
        f"{SOURCE},drawtext=fontfile={font}:text='GOLDEN RIVERS':fontsize=48:fontcolor=white:x=40:y=120",
        ["-c:v", "ffv1"],
    )
    job = JobContext.detached()
    found = burned_in.detect(str(burned), words, RATE, Fraction(0), job)
    assert found is not None and found["found"] is True and found["confidence"] >= 0.8
    # The captions sit in the look's band near the bottom: the region says so, from the top.
    assert 0.5 < found["region"]["y0"] < found["region"]["y1"] < 0.8
    assert burned_in.detect(str(plain), words, RATE, Fraction(0), job) == {"found": False, "confidence": 0.0}
    assert burned_in.detect(str(signed), words, RATE, Fraction(0), job) == {"found": False, "confidence": 0.0}


@pytest.mark.usefixtures("tools")
def test_a_clip_that_cant_be_read_is_left_unchecked(tmp_path: Path) -> None:
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")
    assert burned_in.detect(str(broken), _words(), RATE, Fraction(0), JobContext.detached()) is None
    assert burned_in.detect(str(broken), [], RATE, Fraction(0), JobContext.detached()) is None
