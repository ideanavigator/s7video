# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Captions already in the picture (S7V-099), found while a clip is transcribed.

Ten frames are taken at the middle of evenly spaced spoken words, and Apple's Vision framework
reads their text on this Mac (no download; nothing leaves the device). A frame shows captions when
a line of its text is mostly words said within ``WINDOW_SECONDS`` of it. A line seen in at least
half the frames is part of the picture (a logo, a sign, a name card), never a caption, even if the
speaker says it. The clip has burned-in captions when enough frames show them.

The result keeps only ``found``, ``confidence`` (the share of frames that showed captions) and the
caption band (``region``, from the top of the frame, 0–1); the text read is never stored.
"""

from __future__ import annotations

import math
import re
import tempfile
from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from .ffmpeg import run_tool
from .jobs import JobContext
from .rpc import RpcError

SAMPLES = 10
WINDOW_SECONDS = 2.0
#: A line seen in this share of the frames, or more, is part of the picture.
STATIC_SHARE = 0.5
#: The share of frames, and the least number, that must show captions.
FOUND_SHARE = 0.4
MIN_FOUND = 3
#: Frames are read at this height: caption text stays well over Vision's smallest readable size.
SAMPLE_HEIGHT = 960
#: Extracting ten frames from a long clip seeks ten times; this is ample on an 8 GB M1 Air.
EXTRACT_TIMEOUT = 60.0

_TOKEN = re.compile(r"[\w']+", re.UNICODE)


@dataclass(frozen=True)
class Line:
    """One line of text Vision read, its top and bottom as shares of the frame's height."""

    text: str
    top: float
    bottom: float


def tokens(text: str) -> list[str]:
    """Words of two characters or more, lower case, without punctuation: "I" and "a" match anything."""
    return [token for token in _TOKEN.findall(text.lower()) if len(token) >= 2]


def sample_seconds(words: list[dict[str, Any]], rate: Fraction, count: int = SAMPLES) -> list[float]:
    """Seconds from the video's first frame at the middle of ``count`` evenly spaced words."""
    if not words:
        return []
    if len(words) <= count:
        picks = words
    else:
        picks = [words[round(index * (len(words) - 1) / (count - 1))] for index in range(count)]
    return [float(Fraction(word["startFrame"] + word["endFrame"], 2) / rate) for word in picks]


def spoken_near(words: list[dict[str, Any]], rate: Fraction, at: float) -> set[str]:
    out: set[str] = set()
    for word in words:
        start, end = float(word["startFrame"] / rate), float(word["endFrame"] / rate)
        if start - WINDOW_SECONDS <= at <= end + WINDOW_SECONDS:
            out.update(tokens(word["text"]))
    return out


def assess(frames: list[list[Line]], spoken: list[set[str]]) -> dict[str, Any]:
    """``burnedInCaptions`` from the lines read in each frame and the words said around it."""
    seen = Counter(key for lines in frames for key in {" ".join(tokens(line.text)) for line in lines} if key)
    static = {key for key, count in seen.items() if count >= 2 and count >= STATIC_SHARE * len(frames)}
    matched = 0
    top, bottom = 1.0, 0.0
    for lines, said in zip(frames, spoken, strict=True):
        hits = []
        for line in lines:
            words = tokens(line.text)
            if not words or " ".join(words) in static:
                continue
            found = sum(1 for word in words if word in said)
            if found >= min(2, len(words)) and found * 2 >= len(words):
                hits.append(line)
        if hits:
            matched += 1
            top = min(top, *(line.top for line in hits))
            bottom = max(bottom, *(line.bottom for line in hits))
    found = bool(frames) and matched >= max(MIN_FOUND, math.ceil(FOUND_SHARE * len(frames)))
    result: dict[str, Any] = {"found": found, "confidence": round(matched / len(frames), 2) if frames else 0.0}
    if found:
        result["region"] = {"y0": round(max(0.0, top), 3), "y1": round(min(1.0, bottom), 3)}
    return result


def extract_frames(path: str, seconds: list[float], folder: Path, job: JobContext) -> list[Path]:
    """One PNG per time, ``SAMPLE_HEIGHT`` tall, in one FFmpeg run (an input per time, each seeking)."""
    args = ["-nostdin", "-v", "error", "-y"]
    for at in seconds:
        args += ["-ss", f"{at:.3f}", "-i", path]
    outputs = [folder / f"frame-{index:02d}.png" for index in range(len(seconds))]
    for index, output in enumerate(outputs):
        args += ["-map", f"{index}:v:0", "-frames:v", "1", "-vf", f"scale=-2:{SAMPLE_HEIGHT}", str(output)]
    run_tool("ffmpeg", args, job, timeout=EXTRACT_TIMEOUT)
    return outputs


def vision_available() -> bool:
    try:
        import Vision  # noqa: F401
    except ImportError:
        return False
    return True


def read_lines(png: Path) -> list[Line]:
    """The text lines Apple Vision reads in an image, on this Mac."""
    import objc
    import Vision
    from Foundation import NSURL

    # The engine's worker threads have no Cocoa autorelease pool of their own.
    with objc.autorelease_pool():
        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(png)), None)
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setUsesLanguageCorrection_(False)
        ok, _error = handler.performRequests_error_([request], None)
        if not ok:
            return []
        lines = []
        for observation in request.results() or []:
            candidates = observation.topCandidates_(1)
            if not candidates:
                continue
            box = observation.boundingBox()
            # Vision's boxes start at the bottom left; ours at the top.
            top, bottom = 1 - float(box.origin.y + box.size.height), 1 - float(box.origin.y)
            lines.append(Line(str(candidates[0].string()), top, bottom))
        return lines


def detect(path: str, words: list[dict[str, Any]], rate: Fraction, offset: Fraction, job: JobContext) -> dict[str, Any] | None:
    """``burnedInCaptions`` for the clip at ``path``, or ``None`` when it can't be checked (no
    Vision, no words, or the frames can't be read): the clip then behaves as one never checked.

    ``words`` are the transcript's, in frames at ``rate`` from the video's first frame, which is
    ``offset`` seconds into the file.
    """
    seconds = sample_seconds(words, rate)
    if not seconds or not vision_available():
        return None
    with tempfile.TemporaryDirectory(prefix="s7-burned-in-") as folder:
        try:
            pngs = extract_frames(path, [float(offset) + at for at in seconds], Path(folder), job)
            frames = [read_lines(png) if png.is_file() else [] for png in pngs]
        except (OSError, RpcError):
            return None
    return assess(frames, [spoken_near(words, rate, at) for at in seconds])
