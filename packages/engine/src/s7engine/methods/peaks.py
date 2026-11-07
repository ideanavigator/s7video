# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.peaks`: a clip's waveform as min/max pairs at several zoom levels (S7V-035).

FFmpeg decodes the first audio stream to mono 48 kHz float32, streamed through a pipe: only one
read block and the finest level stay in memory, never the whole clip. The finest level is computed
from the samples; each coarser level is the min/max of the finer level's buckets, so the levels
nest exactly. Peak `i` of a level covers samples `[i * samplesPerPeak, (i + 1) * samplesPerPeak)`
counted from the first audio sample; `offsetSamples` places that sample against the video's first
frame. The server chooses `outputDir`; the files appear complete or not at all (`index.json` last).
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import uuid
from fractions import Fraction
from typing import TYPE_CHECKING, Any

from ..ffmpeg import _tool_env, tool_path
from ..jobs import Cancelled, JobContext
from ..rpc import INVALID_PARAMS, MEDIA_ERROR, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, media_file
from .transcribe import NO_AUDIO, _media_clock

if TYPE_CHECKING:
    import numpy as np

SAMPLE_RATE = 48_000
DEFAULT_LEVELS = (256, 1024, 4096, 16_384)
INDEX_VERSION = 1
INDEX_FILE = "index.json"
#: Samples read per block: 4 MiB of float32, a whole number of buckets at every default level.
READ_SAMPLES = 1 << 20


def level_file(samples_per_peak: int) -> str:
    return f"{samples_per_peak}.f32"


def bucket_peaks(pcm: np.ndarray, samples_per_peak: int) -> np.ndarray:
    """Min and max of each `samples_per_peak` run, as an `(n, 2)` float32 array; a short last run counts."""
    import numpy as np

    count = -(-len(pcm) // samples_per_peak)
    out = np.empty((count, 2), dtype=np.float32)
    whole = len(pcm) // samples_per_peak
    if whole:
        runs = pcm[: whole * samples_per_peak].reshape(whole, samples_per_peak)
        out[:whole, 0] = runs.min(axis=1)
        out[:whole, 1] = runs.max(axis=1)
    if count > whole:
        tail = pcm[whole * samples_per_peak :]
        out[whole] = (tail.min(), tail.max())
    return out


def coarsen(finer: np.ndarray, factor: int) -> np.ndarray:
    """The next level up: min of the mins and max of the maxes of each `factor` finer peaks."""
    import numpy as np

    count = -(-len(finer) // factor)
    padded = np.empty((count * factor, 2), dtype=np.float32)
    padded[: len(finer)] = finer
    # Padding repeats the last peak, which changes neither the min nor the max of its group.
    if len(finer):
        padded[len(finer) :] = finer[-1]
    groups = padded.reshape(count, factor, 2)
    return np.stack([groups[:, :, 0].min(axis=1), groups[:, :, 1].max(axis=1)], axis=1)


def peaks_mip(blocks: Any, levels: list[int]) -> tuple[int, list[np.ndarray]]:
    """Every level from an iterable of float32 sample blocks; returns (total samples, levels)."""
    import numpy as np

    finest = levels[0]
    carry = np.empty(0, dtype=np.float32)
    parts: list[np.ndarray] = []
    total = 0
    for block in blocks:
        total += len(block)
        samples = np.concatenate([carry, block]) if len(carry) else block
        whole = (len(samples) // finest) * finest
        if whole:
            parts.append(bucket_peaks(samples[:whole], finest))
        carry = samples[whole:].copy()
    if len(carry):
        parts.append(bucket_peaks(carry, finest))
    result = [np.concatenate(parts) if parts else np.empty((0, 2), dtype=np.float32)]
    for finer, coarser in zip(levels, levels[1:]):
        result.append(coarsen(result[-1], coarser // finer))
    return total, result


def _check_levels(levels: list[int]) -> None:
    if sorted(set(levels)) != levels:
        raise RpcError(INVALID_PARAMS, "invalid params at levels: must be distinct and ascending")
    if any(coarser % finer for finer, coarser in zip(levels, levels[1:])):
        raise RpcError(INVALID_PARAMS, "invalid params at levels: each level must divide the next")


def publish(output_dir: str, staging: str, names: list[str], index: dict[str, Any]) -> None:
    """Moves finished files from `staging` into `output_dir`, the index last, then drops `staging`.

    The old index goes first, so a reader never sees an index naming files of a different run.
    """
    with contextlib.suppress(FileNotFoundError):
        os.remove(os.path.join(output_dir, INDEX_FILE))
    for name in names:
        os.replace(os.path.join(staging, name), os.path.join(output_dir, name))
    index_part = os.path.join(staging, INDEX_FILE)
    with open(index_part, "w", encoding="utf-8") as handle:
        json.dump(index, handle, separators=(",", ":"))
    os.replace(index_part, os.path.join(output_dir, INDEX_FILE))
    shutil.rmtree(staging, ignore_errors=True)


def staging_dir(output_dir: str) -> str:
    if not os.path.isabs(output_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at outputDir: must be absolute")
    staging = os.path.join(output_dir, f".tmp-{uuid.uuid4().hex}")
    try:
        os.makedirs(staging)
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the media data folder cannot be created") from None
    return staging


def _blocks(process: subprocess.Popen[bytes], job: JobContext, total_samples: int) -> Any:
    import numpy as np

    assert process.stdout is not None
    read = 0
    reported = 0.0
    pending = b""
    while True:
        chunk = process.stdout.read(READ_SAMPLES * 4)
        if not chunk:
            break
        data = pending + chunk
        usable = len(data) - len(data) % 4
        pending = data[usable:]
        block = np.frombuffer(data[:usable], dtype="<f4")
        read += len(block)
        done = min(read / total_samples, 0.99) if total_samples > 0 else 0.0
        # Every 1 %, as for the filmstrip: each report republishes the media list.
        if done - reported >= 0.01:
            reported = done
            job.progress(done, "waveform")
        yield block


def _peaks(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    output_dir = params["outputDir"]
    levels = list(params.get("levels") or DEFAULT_LEVELS)
    _check_levels(levels)
    media_file(path)
    job.progress(0, "waveform")
    try:
        info = _media_clock(path, job)
    except RpcError as error:
        if error.code != NO_AUDIO:
            raise
        info = None
    staging = staging_dir(output_dir)
    try:
        if info is None:
            index: dict[str, Any] = {"version": INDEX_VERSION, "audio": False, "sampleRate": SAMPLE_RATE, "levels": []}
            publish(output_dir, staging, [], index)
            return {"audio": False, "sampleRate": SAMPLE_RATE, "levels": []}
        clock = info.clock
        total_estimate = round(Fraction(info.duration_frames) / clock.rate * SAMPLE_RATE)
        args = [tool_path("ffmpeg"), "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1"]
        args += ["-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_tool_env())
        stop = process.kill
        job.on_cancel(stop)
        try:
            total, mip = peaks_mip(_blocks(process, job, total_estimate), levels)
            process.wait()
        except Cancelled:
            process.kill()
            process.wait()
            raise
        finally:
            job.remove_on_cancel(stop)
        job.raise_if_cancelled()
        if process.returncode != 0:
            raise RpcError(MEDIA_ERROR, "the sound could not be read")
        entries = []
        for samples_per_peak, peaks in zip(levels, mip):
            name = level_file(samples_per_peak)
            peaks.astype("<f4").tofile(os.path.join(staging, name))
            entries.append({"samplesPerPeak": samples_per_peak, "count": len(peaks), "file": name})
        job.raise_if_cancelled()
        offset = round((clock.audio_start - clock.video_start) * SAMPLE_RATE)
        index = {
            "version": INDEX_VERSION,
            "audio": True,
            "sampleRate": SAMPLE_RATE,
            "channels": 1,
            "durationSamples": total,
            "offsetSamples": offset,
            "levels": entries,
        }
        publish(output_dir, staging, [entry["file"] for entry in entries], index)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        raise RpcError(OUTPUT_ERROR, "the waveform could not be written") from None
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {"audio": True, "sampleRate": SAMPLE_RATE, "durationSamples": total, "offsetSamples": offset, "levels": entries}


METHOD = Method(
    "media.peaks",
    _peaks,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["jobId", "path", "outputDir"],
        "properties": {
            "jobId": {"type": "string"},
            "path": PATH_SCHEMA,
            "outputDir": PATH_SCHEMA,
            "levels": {
                "type": "array",
                "minItems": 1,
                "maxItems": 8,
                "items": {"type": "integer", "minimum": 16, "maximum": 1 << 20},
            },
        },
    },
    job=True,
)
