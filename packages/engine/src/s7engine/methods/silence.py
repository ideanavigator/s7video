# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`silence.detect`: the loudness of a clip's sound, one whole-decibel value per video frame.

The levels sit on the same frame clock as the transcript (`transcribe._media_clock`), so level `n`
is the sound under video frame `n` and lines up with word frames. The server decides which word
gaps are quiet enough to cut (S7V-027); the engine only measures.

The transcribe job measures them from the audio it already decoded and caches them next to the
transcript as `<cacheDir>/<sha256>.levels.json` (S7V-055), so silence removal never decodes the
clip again. `silence.detect` is the job that measures them when that file is missing.
"""

from __future__ import annotations

import json
import os
import threading
from fractions import Fraction
from typing import TYPE_CHECKING, Any

from .. import timebase
from ..jobs import JobContext
from ..rpc import INVALID_PARAMS, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, media_file
from .transcribe import FINGERPRINT_SCHEMA, SAMPLE_RATE, FrameClock, _media_clock, decode_audio

if TYPE_CHECKING:
    import numpy as np

#: Digital silence and frames with no audio under them read as this.
FLOOR_DB = -100
LEVELS_VERSION = 1
#: Samples squared and summed at a time: 8 MiB of float64, never a whole-clip copy (S7V-055).
LEVEL_BLOCK_SAMPLES = 1 << 20


def frame_levels(
    pcm: np.ndarray, clock: FrameClock, duration_frames: int, block: int = LEVEL_BLOCK_SAMPLES
) -> list[int]:
    """RMS dBFS of the samples under each frame, rounded to whole decibels, at least `FLOOR_DB`.

    The running sum of squares is built `block` samples at a time in float64, carrying the total
    from block to block, so it is the same sequence of additions as one whole-clip `cumsum` and
    gives the same integers, while holding at most two blocks (about 17 MB) besides the audio.
    """
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
    # energy[i] is the sum of squares of the samples before edge i.
    energy = np.zeros(duration_frames + 1, dtype=np.float64)
    carry = 0.0
    for start in range(0, len(pcm), block):
        running = pcm[start : start + block].astype(np.float64)
        np.square(running, out=running)
        running[0] += carry
        np.cumsum(running, out=running)
        lo = int(np.searchsorted(edges, start, side="right"))
        hi = int(np.searchsorted(edges, start + len(running), side="right"))
        energy[lo:hi] = running[edges[lo:hi] - 1 - start]
        carry = float(running[-1])
    counts = np.diff(edges)
    sums = energy[1:] - energy[:-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)
        db = np.where(mean > 0, 10 * np.log10(np.maximum(mean, 1e-30)), FLOOR_DB)
    return [int(value) for value in np.clip(np.rint(db), FLOOR_DB, 0)]


# --- Cache ------------------------------------------------------------------------------------


def levels_path(cache_dir: str, fingerprint: dict[str, Any]) -> str:
    return os.path.join(cache_dir, f"{fingerprint['sha256']}.levels.json")


def levels_document(
    fingerprint: dict[str, Any], rate: Fraction, duration_frames: int, levels: list[int]
) -> dict[str, Any]:
    return {
        "levelsVersion": LEVELS_VERSION,
        "mediaFingerprint": fingerprint,
        "fps": timebase.rational(Fraction(rate)),
        "durationFrames": duration_frames,
        "levels": levels,
    }


def read_levels(cache_dir: str, fingerprint: dict[str, Any]) -> dict[str, Any] | None:
    """The cached levels for this media, or None if missing, half-written or for another file."""
    try:
        with open(levels_path(cache_dir, fingerprint), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("levelsVersion") != LEVELS_VERSION:
        return None
    if data.get("mediaFingerprint") != fingerprint:
        return None
    levels, frames, fps = data.get("levels"), data.get("durationFrames"), data.get("fps")
    if not isinstance(levels, list) or not isinstance(frames, int) or len(levels) != frames:
        return None
    if not isinstance(fps, dict) or not all(isinstance(fps.get(key), int) for key in ("num", "den")):
        return None
    return data


def write_levels(cache_dir: str, document: dict[str, Any], job: JobContext) -> None:
    """Writes `<sha256>.levels.json` whole or not at all (`.part`, then `os.replace`)."""
    target = levels_path(cache_dir, document["mediaFingerprint"])
    try:
        os.makedirs(cache_dir, exist_ok=True)
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the transcript folder cannot be created") from None
    partial = f"{target}.{os.getpid()}.{threading.get_ident()}.part"
    job.track_output(partial)
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(document, handle, separators=(",", ":"))
    job.raise_if_cancelled()
    os.replace(partial, target)
    job.keep_output(partial)


# --- Method -----------------------------------------------------------------------------------


def _detect(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    cache_dir = params.get("cacheDir")
    fingerprint = params.get("fingerprint")
    if (cache_dir is None) != (fingerprint is None):
        raise RpcError(INVALID_PARAMS, "invalid params: cacheDir and fingerprint go together")
    if cache_dir is not None and not os.path.isabs(cache_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at cacheDir: must be absolute")
    media_file(path)
    if cache_dir is not None:
        cached = read_levels(cache_dir, fingerprint)
        if cached is not None:
            return {"rate": cached["fps"], "durationFrames": cached["durationFrames"], "levels": cached["levels"]}
    job.progress(0.0, "measuring the sound")
    info = _media_clock(path, job)
    pcm = decode_audio(path, job)
    job.progress(0.8, "measuring the sound")
    levels = frame_levels(pcm, info.clock, info.duration_frames)
    del pcm
    job.raise_if_cancelled()
    if cache_dir is not None:
        write_levels(cache_dir, levels_document(fingerprint, info.clock.rate, info.duration_frames, levels), job)
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
        "required": ["jobId", "path"],
        "properties": {
            "jobId": {"type": "string"},
            "path": PATH_SCHEMA,
            "cacheDir": PATH_SCHEMA,
            "fingerprint": FINGERPRINT_SCHEMA,
        },
    },
    job=True,
)
