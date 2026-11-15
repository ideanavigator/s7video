# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``burned-in-caption-detect`` (S7V-099): Apple Vision tells a clip with captions in its
picture from one without, on ``talking-head-01``.

The first 40 s of the clip, three ways, made by FFmpeg at test time and never committed: as it
is; with our own captions burned in from its stored transcript (the export's ASS and libass, in
the plain look, at 9:16 and at the clip's 16:9); and with a sign, "WIKIPEDIA", which the speaker
says again and again, in the corner throughout. ``found`` must equal the reference exactly: true
only for the burned-in copies. The check's time for the ten frames is printed (target under 2 s
on this Mac). Needs macOS with Vision (``pyobjc-framework-Vision``) and FFmpeg with libass.

Run with ``pnpm test:golden -- burned-in-caption-detect``; ``S7VIDEO_GOLDEN_UPDATE=1`` records the
reference (say why in the PR).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from fractions import Fraction
from pathlib import Path

import harness
import pytest

from s7engine import burned_in, captions_ass
from s7engine.jobs import JobContext

TRANSCRIPT = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.transcript.json"
REFERENCE = Path(__file__).parent / "references" / "burned-in-caption-detect.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
SECONDS = 40


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    if not burned_in.vision_available():
        pytest.skip("needs Apple Vision (pyobjc-framework-Vision on macOS)")
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _ffmpeg(args: list[str], cwd: Path) -> None:
    subprocess.run([harness._tool("ffmpeg"), "-v", "error", "-y", *args], check=True, cwd=cwd)


def _clips(source: Path, folder: Path, words: list[dict], rate: Fraction) -> dict[str, Path]:
    """The plain, burned-in and signed copies; mpeg4 at high quality, no GPL encoder."""
    encode = ["-an", "-c:v", "mpeg4", "-q:v", "2"]
    clips = {"plain": folder / "plain.mp4", "portrait-plain": folder / "portrait-plain.mp4"}
    _ffmpeg(["-t", str(SECONDS), "-i", str(source), *encode, str(clips["plain"])], folder)
    _ffmpeg(
        ["-i", str(clips["plain"]), "-vf", "crop=608:1080:643:0,scale=1080:1920", *encode, str(clips["portrait-plain"])],
        folder,
    )
    chunks = captions_ass.chunk_words([captions_ass.Word(w["text"], w["startFrame"], w["endFrame"]) for w in words], rate)
    captions_ass.link_fonts(folder / "fonts")
    for name, plain, (width, height) in (
        ("burned", clips["plain"], (1894, 1080)),
        ("portrait-burned", clips["portrait-plain"], (1080, 1920)),
    ):
        captions_ass.write_ass(folder / f"{name}.ass", chunks, rate, width, height)
        clips[name] = folder / f"{name}.mp4"
        _ffmpeg(["-i", str(plain), "-vf", f"subtitles=filename={name}.ass:fontsdir=fonts", *encode, str(clips[name])], folder)
    font = captions_ass.FONTS_DIR / "Inter-Bold.ttf"
    clips["sign"] = folder / "sign.mp4"
    _ffmpeg(
        [
            "-i", str(clips["plain"]), "-vf",
            f"drawtext=fontfile={font}:text='WIKIPEDIA':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.6:x=60:y=60",
            *encode, str(clips["sign"]),
        ],
        folder,
    )
    return clips


def test_burned_in_caption_detect(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    stored = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    rate = Fraction(stored["fps"]["num"], stored["fps"]["den"])
    words = [word for word in stored["words"] if word["endFrame"] < SECONDS * rate - 1]
    clips = _clips(source, tmp_path, words, rate)

    found: dict[str, bool] = {}
    for name in ("plain", "burned", "portrait-plain", "portrait-burned", "sign"):
        started = time.perf_counter()
        result = burned_in.detect(str(clips[name]), words, rate, Fraction(0), JobContext.detached())
        took = time.perf_counter() - started
        assert result is not None, name
        print(f"burned-in-caption-detect {name}: {json.dumps(result)} in {took:.2f} s")
        found[name] = result["found"]
        if result["found"]:
            # Our plain look sits in the safe zone's bottom part.
            assert 0.5 < result["region"]["y0"] < result["region"]["y1"] < 0.95, result

    actual = {"clip": "talking-head-01", "seconds": SECONDS, "found": found}
    if UPDATE:
        REFERENCE.write_text(json.dumps(actual, indent=2) + "\n", encoding="utf-8")
    assert json.loads(REFERENCE.read_text(encoding="utf-8")) == actual
    assert found == {"plain": False, "burned": True, "portrait-plain": False, "portrait-burned": True, "sign": False}
