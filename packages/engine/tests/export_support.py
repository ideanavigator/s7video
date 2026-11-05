# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Builders for export tests: an ``edit.json`` from keep ranges, and the probe numbers it needs.

Keep ranges are half-open source frames ``(in, out)`` at the edit's rate, played in order.
"""

from __future__ import annotations

import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

from engine_support import FFMPEG, FFPROBE


def keep_ranges(source_frames: int, count: int, total: int, margin: int = 5) -> list[tuple[int, int]]:
    """``count`` ranges of near-equal length adding up to ``total`` frames, evenly spaced."""
    lengths = [total // count + (1 if index < total % count else 0) for index in range(count)]
    gap = (source_frames - 2 * margin - total) // count
    ranges, at = [], margin
    for length in lengths:
        ranges.append((at, at + length))
        at += length + gap
    return ranges


def timeline_of(ranges: list[tuple[int, int]], frame: int) -> int | None:
    """Where source frame ``frame`` lands on the timeline, or None when it was cut."""
    at = 0
    for start, end in ranges:
        if start <= frame < end:
            return at + frame - start
        at += end - start
    return None


def make_edit(
    *,
    source: Path,
    ranges: list[tuple[int, int]],
    fps: Fraction,
    duration_frames: int,
    width: int = 1080,
    height: int = 1920,
    captions: list[dict[str, Any]] | None = None,
    has_audio: bool = True,
) -> dict[str, Any]:
    items, at = [], 0
    for index, (start, end) in enumerate(ranges):
        items.append({"id": f"v{index}", "media": "cam", "start": at, "duration": end - start, "in": start})
        at += end - start
    tracks: list[dict[str, Any]] = [{"kind": "video", "id": "V1", "role": "main", "items": items}]
    if captions is not None:
        tracks.append({"kind": "caption", "id": "C1", "style": "s7-neutral", "items": captions})
    return {
        "version": 1,
        "fps": {"num": fps.numerator, "den": fps.denominator},
        "canvas": {"width": width, "height": height},
        "media": [
            {
                "id": "cam",
                "kind": "video",
                "reference": str(source),
                "fingerprint": {"sha256": "0" * 64, "size": source.stat().st_size},
                "probe": {"hasVideo": True, "hasAudio": has_audio, "durationFrames": duration_frames},
            }
        ],
        "tracks": tracks,
        "markers": [],
        "metadata": {},
    }


def caption_items_from_words(words: list[dict[str, Any]], ranges: list[tuple[int, int]]) -> list[dict[str, Any]]:
    """One caption item per word kept whole by the cut, on the timeline (words.json shape in)."""
    items = []
    for index, word in enumerate(words):
        start = timeline_of(ranges, word["start"])
        last = timeline_of(ranges, word["end"] - 1)
        if start is None or last is None or last - start != word["end"] - 1 - word["start"]:
            continue
        duration = word["end"] - word["start"]
        items.append(
            {
                "id": f"c{index}",
                "start": start,
                "duration": duration,
                "text": word["text"],
                "words": [{"text": word["text"], "start": start, "duration": duration}],
            }
        )
    return items


def decode_gray(path: Path, size: str, extra: list[str] | None = None) -> bytes:
    assert FFMPEG is not None
    return subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), *(extra or []), "-vf", f"scale={size}:flags=area,format=gray", "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout


def decode_audio_mono(path: Path) -> list[float]:
    import array

    assert FFMPEG is not None
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    samples = array.array("f")
    samples.frombytes(raw)
    return list(samples)


def stream_info(path: Path) -> dict[str, Any]:
    import json

    assert FFPROBE is not None
    out = subprocess.run(
        [
            FFPROBE,
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels,"
            "color_space,color_transfer,color_primaries,color_range,nb_read_frames,start_time,duration",
            "-show_entries",
            "format=format_name",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)
