# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Captions from a clip's transcript, for an edit with no caption items (S7V-046).

Each transcript word (integer frames of its clip, at the transcript's rate) is mapped through the
video track's keep ranges onto the output timeline: a word wholly in a removed range is dropped, a
word crossing a cut keeps only its kept frames. Words are chunked per run of the timeline that
plays its source without a cut, so no caption spans a join.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from . import captions_ass, timebase


@dataclass(frozen=True)
class Kept:
    """A stretch of the timeline that plays ``media`` from ``source_in`` without a cut."""

    timeline_start: int
    frames: int
    media: str
    source_in: int


def _runs(segments: list[Any]) -> list[Kept]:
    """Joins segments that continue their source exactly (a split, not a cut)."""
    runs: list[Kept] = []
    for segment in segments:
        if segment.media is None or segment.frames <= 0:
            continue
        last = runs[-1] if runs else None
        if (
            last is not None
            and last.media == segment.media
            and last.timeline_start + last.frames == segment.timeline_start
            and last.source_in + last.frames == segment.source_in
        ):
            runs[-1] = Kept(last.timeline_start, last.frames + segment.frames, last.media, last.source_in)
        else:
            runs.append(Kept(segment.timeline_start, segment.frames, segment.media, segment.source_in))
    return runs


def _to_rate(frame: int, scale: Fraction) -> int:
    return math.floor(frame * scale + Fraction(1, 2))


def map_words(segments: list[Any], transcripts: dict[str, dict[str, Any]], rate: Fraction) -> list[list[captions_ass.Word]]:
    """The kept words on the timeline, one list per uncut run, in timeline order."""
    groups: list[list[captions_ass.Word]] = []
    for run in _runs(segments):
        transcript = transcripts.get(run.media)
        if transcript is None:
            continue
        scale = rate / timebase.from_rational(transcript["fps"])
        low, high = run.source_in, run.source_in + run.frames
        words: list[captions_ass.Word] = []
        for word in transcript["words"]:
            text = str(word["text"]).strip()
            start = max(_to_rate(word["startFrame"], scale), low)
            end = min(_to_rate(word["endFrame"], scale), high)
            if text and end > start:
                shift = run.timeline_start - low
                words.append(captions_ass.Word(text, start + shift, end + shift))
        words.sort(key=lambda word: word.start)
        if words:
            groups.append(words)
    return groups


def transcript_chunks(
    segments: list[Any],
    transcripts: dict[str, dict[str, Any]],
    rate: Fraction,
    end_frame: int,
    style_id: str = captions_ass.DEFAULT_STYLE,
) -> list[captions_ass.Chunk]:
    style = captions_ass.load_style(style_id)
    groups = map_words(segments, transcripts, rate)
    chunks = [chunk for words in groups for chunk in captions_ass.chunk_words(words, rate, style)]
    return captions_ass.clip_chunks(chunks, end_frame)
