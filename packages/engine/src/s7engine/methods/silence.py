# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`silence.detect`: the loudness of a clip's sound, one whole-decibel value per video frame.

The levels sit on the same frame clock as the transcript (`transcribe._media_clock`), so level `n`
is the sound under video frame `n` and lines up with word frames. The server decides which word
gaps are quiet enough to cut (S7V-027); the engine only measures.
"""

from __future__ import annotations

from fractions import Fraction
from typing import TYPE_CHECKING, Any

from .. import timebase
from ..jobs import JobContext
from ..rpc import Method
from ._media import PATH_SCHEMA, media_file
from .transcribe import SAMPLE_RATE, FrameClock, _media_clock, decode_audio

if TYPE_CHECKING:
    import numpy as np

#: Digital silence and frames with no audio under them read as this.
FLOOR_DB = -100


def frame_levels(pcm: np.ndarray, clock: FrameClock, duration_frames: int) -> list[int]:
    """RMS dBFS of the samples under each frame, rounded to whole decibels, at least `FLOOR_DB`."""
    import numpy as np

    if duration_frames <= 0:
        return []
    # Sample index of each frame boundary, exact on the media clock, clamped to the decoded audio.
    edges = np.empty(duration_frames + 1, dtype=np.int64)
    offset = clock.video_start - clock.audio_start
    for index in range(duration_frames + 1):
        seconds = offset + timebase.frame_to_seconds(index, clock.rate)
        edges[index] = round(seconds * SAMPLE_RATE)
    edges = np.clip(edges, 0, len(pcm))
    counts = np.diff(edges)
    energy = np.concatenate(([0.0], np.cumsum(pcm.astype(np.float64) ** 2)))
    sums = energy[edges[1:]] - energy[edges[:-1]]
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)
        db = np.where(mean > 0, 10 * np.log10(np.maximum(mean, 1e-30)), FLOOR_DB)
    return [int(value) for value in np.clip(np.rint(db), FLOOR_DB, 0)]


def _detect(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    media_file(path)
    info = _media_clock(path, job)
    pcm = decode_audio(path, job)
    levels = frame_levels(pcm, info.clock, info.duration_frames)
    return {
        "rate": timebase.rational(Fraction(info.clock.rate)),
        "durationFrames": info.duration_frames,
        "levels": levels,
    }


METHOD = Method(
    "silence.detect",
    _detect,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["path"],
        "properties": {"path": PATH_SCHEMA},
    },
)
