# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`transcribe.run`, `transcribe.models.status` and `transcribe.models.download` (ADR-006).

Pipeline (spike A1): 16 kHz mono audio from FFmpeg; chunks cut at pauses, at most 25 s each and
starting 0.4 s early so a chunk's first word is not lost; Qwen3-ASR then Qwen3-ForcedAligner per
chunk; words merged so each pause belongs to one chunk; words aligned onto audio below -50 dBFS
dropped; times turned into integer frames at the video's rate, counted from its first frame.

The result is cached at `<cacheDir>/<fingerprint sha256>.json` and returned as a path, with the
clip's per-frame sound levels beside it in `<sha256>.levels.json` (`silence.py`, S7V-055). A cache hit
for the same media and model never loads the model. Only frames reach the cache, never seconds.
"""

from __future__ import annotations

import difflib
import json
import math
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from fractions import Fraction
from typing import TYPE_CHECKING, Any

from .. import models, timebase
from ..ffmpeg import ffprobe_json, run_tool
from ..jobs import JobContext
from ..rpc import INVALID_PARAMS, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, media_file

if TYPE_CHECKING:
    import numpy as np

TRANSCRIPT_VERSION = 1
SAMPLE_RATE = 16_000
MAX_CHUNK_S = 25.0
#: Each chunk starts this early: 0.15 s dropped a chunk's first word in spike A1.
CHUNK_LEAD_S = 0.4
CHUNK_TAIL_S = 0.4
PAUSE_DB = -35.0
PAUSE_MIN_S = 0.25
#: A word whose aligned span averages below this is on silence, not speech (spike A1: -58 dBFS blip).
SILENT_WORD_DBFS = -50.0
#: The aligner's time step when its config does not say (Qwen3-ForcedAligner: 80 ms).
DEFAULT_ALIGNER_STEP_S = 0.08
NO_AUDIO = 1010
#: Job progress before each model loads, and where transcription starts. A cold load is about
#: half of a 2 min clip's first run (S7V-021: 46 s in all), so it gets a share of the bar.
LOAD_PROGRESS = (0.05, 0.25)
TRANSCRIBE_FROM = 0.4
#: FFmpeg gets this long to decode a clip's audio (about 2 s for 2 min of AV1 here).
AUDIO_DECODE_TIMEOUT = 600.0

_HOLDER: models.ModelHolder | None = None
_HOLDER_LOCK = threading.Lock()


def holder() -> models.ModelHolder:
    global _HOLDER
    with _HOLDER_LOCK:
        if _HOLDER is None:
            _HOLDER = models.ModelHolder(models.idle_seconds_from_env())
        return _HOLDER


# --- Chunking ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    """`lo`..`hi` is the audio given to the model; `core_start`..`core_end` is the speech found."""

    lo: float
    hi: float
    core_start: float
    core_end: float


def _db(frames: np.ndarray) -> np.ndarray:
    import numpy as np  # Imported on first use: the engine starts in well under 100 ms without it.

    return 20 * np.log10(np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1)) + 1e-9)


def hop_levels(pcm: np.ndarray, hop_s: float = 0.01) -> np.ndarray:
    import numpy as np

    n = int(hop_s * SAMPLE_RATE)
    usable = len(pcm) // n * n
    if usable == 0:
        return np.zeros(0)
    return _db(pcm[:usable].reshape(-1, n))


def speech_spans(pcm: np.ndarray, hop_s: float = 0.01) -> list[tuple[float, float]]:
    """Speech islands in seconds, split by pauses of at least `PAUSE_MIN_S` below `PAUSE_DB`."""
    quiet = hop_levels(pcm, hop_s) < PAUSE_DB
    spans: list[tuple[float, float]] = []
    start: int | None = None
    run = 0
    for index, is_quiet in enumerate(quiet):
        if not is_quiet:
            if start is None:
                start = index
            run = 0
            continue
        run += 1
        if start is not None and run * hop_s >= PAUSE_MIN_S:
            spans.append((start * hop_s, (index - run + 1) * hop_s))
            start = None
    if start is not None:
        spans.append((start * hop_s, len(quiet) * hop_s))
    return spans


def _split_long(span: tuple[float, float], levels: np.ndarray, limit: float, hop_s: float) -> list[tuple[float, float]]:
    """Cuts speech with no long pause at its quietest 10 ms (the latest, on a tie) in the last
    third of each window."""
    import numpy as np

    out: list[tuple[float, float]] = []
    start, end = span
    while end - start > limit:
        lo, hi = int((start + limit * 2 / 3) / hop_s), int((start + limit) / hop_s)
        window = levels[lo:hi]
        cut = (lo + len(window) - 1 - int(np.argmin(window[::-1]))) * hop_s if len(window) else start + limit
        out.append((start, cut))
        start = cut
    out.append((start, end))
    return out


def plan_chunks(pcm: np.ndarray, hop_s: float = 0.01) -> list[Chunk]:
    """Chunks of at most `MAX_CHUNK_S` seconds of audio, each starting `CHUNK_LEAD_S` early."""
    total = len(pcm) / SAMPLE_RATE
    levels = hop_levels(pcm, hop_s)
    core_limit = MAX_CHUNK_S - CHUNK_LEAD_S - CHUNK_TAIL_S
    spans = [piece for span in speech_spans(pcm, hop_s) for piece in _split_long(span, levels, core_limit, hop_s)]
    merged: list[list[float]] = []
    for start, end in spans:
        if merged and end - merged[-1][0] <= core_limit:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [
        Chunk(lo=max(0.0, start - CHUNK_LEAD_S), hi=min(total, end + CHUNK_TAIL_S), core_start=start, core_end=end)
        for start, end in merged
    ]


# --- Words ------------------------------------------------------------------------------------


@dataclass
class Word:
    text: str
    start: float
    end: float
    confidence: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def merge_chunks(chunks: list[Chunk], words_per_chunk: list[list[Word]]) -> list[Word]:
    """Joins chunk words; each pause between chunks is split at its middle, so a word heard by two
    chunks (in one's lead and the other's tail) is kept once, by the chunk that owns its start."""
    merged: list[Word] = []
    for index, (chunk, words) in enumerate(zip(chunks, words_per_chunk, strict=True)):
        own_from = -math.inf if index == 0 else (chunks[index - 1].core_end + chunk.core_start) / 2
        own_to = math.inf if index == len(chunks) - 1 else (chunk.core_end + chunks[index + 1].core_start) / 2
        merged.extend(word for word in words if own_from <= word.start < own_to)
    merged.sort(key=lambda word: word.start)
    return merged


def word_dbfs(pcm: np.ndarray, start: float, end: float) -> float:
    import numpy as np

    lo, hi = int(start * SAMPLE_RATE), max(int(end * SAMPLE_RATE), int(start * SAMPLE_RATE) + 1)
    window = pcm[lo:hi].astype(np.float64)
    if window.size == 0:
        return -math.inf
    return 20 * math.log10(math.sqrt(float((window**2).mean())) + 1e-12)


def drop_silent_words(words: list[Word], pcm: np.ndarray) -> list[Word]:
    return [word for word in words if word_dbfs(pcm, word.start, word.end) >= SILENT_WORD_DBFS]


@dataclass(frozen=True)
class FrameClock:
    """Seconds from the start of the decoded audio to video frames: the audio's first sample is
    `audio_start` on the media clock, frame 0 is the video's first frame at `video_start`."""

    rate: Fraction
    audio_start: Fraction = Fraction(0)
    video_start: Fraction = Fraction(0)

    def frame(self, seconds_from_audio_start: float) -> int:
        samples = round(seconds_from_audio_start * SAMPLE_RATE)
        media_time = self.audio_start + Fraction(samples, SAMPLE_RATE)
        return max(0, timebase.seconds_to_frame(media_time - self.video_start, self.rate))


def words_to_frames(words: list[Word], clock: FrameClock) -> list[dict[str, Any]]:
    out = []
    for word in words:
        start = clock.frame(word.start)
        end = max(start + 1, clock.frame(word.end))
        out.append(
            {
                "text": word.text,
                "startFrame": start,
                "endFrame": end,
                "confidence": None if word.confidence is None else round(word.confidence, 3),
                "speaker": "S1",
            }
        )
    return out


_WORD_CHARS = re.compile(r"[\w']+", re.UNICODE)


def _norm(text: str) -> str:
    return "".join(_WORD_CHARS.findall(text.lower()))


def word_confidences(text_pieces: list[tuple[str, float]], aligned: list[str]) -> list[float | None]:
    """Per aligned word, the geometric mean probability of the ASR tokens that spelled it.

    `text_pieces` are (decoded token text, probability) in order. Aligned words are matched to the
    ASR's whitespace words by normalised text; an unmatched word gets None.
    """
    asr_words: list[tuple[str, list[float]]] = []
    for piece, probability in text_pieces:
        if not piece:
            continue
        if piece[0].isspace() or not asr_words:
            asr_words.append((piece.strip(), [probability]))
        else:
            asr_words[-1] = (asr_words[-1][0] + piece, [*asr_words[-1][1], probability])
    asr_norm = [_norm(text) for text, _ in asr_words]
    aligned_norm = [_norm(text) for text in aligned]
    result: list[float | None] = [None] * len(aligned)
    matcher = difflib.SequenceMatcher(a=aligned_norm, b=asr_norm, autojunk=False)
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            probabilities = asr_words[block.b + offset][1]
            result[block.a + offset] = math.exp(sum(math.log(max(p, 1e-9)) for p in probabilities) / len(probabilities))
    return result


# --- Models -----------------------------------------------------------------------------------


def _recognise(asr: Any, piece: np.ndarray) -> tuple[str, str, list[tuple[str, float]]]:
    """(language, text, [(token text, probability)]) from Qwen3-ASR with auto-detected language."""
    tokenizer = asr._tokenizer
    tokens: list[int] = []
    probabilities: list[float] = []
    for token, logprobs in asr.stream_generate(piece):
        token_id = int(token)
        tokens.append(token_id)
        row = logprobs if logprobs.ndim == 1 else logprobs[0]
        probabilities.append(math.exp(float(row[token_id])))
    raw = tokenizer.decode(tokens, skip_special_tokens=True)
    language, text = asr.extract_language(raw)
    # Token texts after the `<asr_text>` marker carry the transcript and its probabilities.
    pieces: list[tuple[str, float]] = []
    started = "<asr_text>" not in raw
    for token_id, probability in zip(tokens, probabilities, strict=True):
        piece_text = tokenizer.decode([token_id], skip_special_tokens=True)
        if not started:
            started = piece_text == "<asr_text>"
            continue
        pieces.append((piece_text, probability))
    return language or "English", text.strip(), pieces


def aligner_step(aligner: Any) -> float:
    """The aligner's time step in seconds, from its config (`timestamp_segment_time`, in ms)."""
    try:
        step_ms = float(aligner.config.timestamp_segment_time)
    except (AttributeError, TypeError, ValueError):
        return DEFAULT_ALIGNER_STEP_S
    return step_ms / 1000 if step_ms > 0 else DEFAULT_ALIGNER_STEP_S


def shift_to_step_middle(start: float, end: float, step: float) -> tuple[float, float]:
    """Moves a word's start to the middle of the aligner step it was reported in; the end stays.

    The aligner reports the step a word starts in, and the onset lies on average half a step later.
    A one-clip calibration (talking-head-01, machine-made marks; re-measure on our own recordings),
    34 scored word starts, frames at 24000/1001, 1.7B (0.6B within 1 point):

    | start shift | mean abs error | within 1 frame |
    | --- | --- | --- |
    | 0 ms | 31.5 ms | 85% (fails AC-5) |
    | 20 ms | 23.6 ms | 91% |
    | 30 ms | 25.6 ms | 91% |
    | 40 ms = step / 2 (used) | 30.7 ms | 94% |
    | 60 ms | 43.2 ms | 85% |

    Ends stay where the aligner put them: shifting them by step / 2 too made 28 scored ends worse
    (82% to 79% within a frame). Full table in MODELS.md, "Word timing calibration".
    """
    return min(start + step / 2, max(start, end)), end


def _transcribe_chunk(asr: Any, aligner: Any, piece: np.ndarray, aligning: Callable[[], None] | None = None) -> list[Word]:
    language, text, pieces = _recognise(asr, piece)
    if not text:
        return []
    if aligning is not None:
        aligning()
    aligned = aligner.generate(piece, text=text, language=language)
    items = list(aligned.items)
    confidences = word_confidences(pieces, [item.text for item in items])
    words = []
    for item, confidence in zip(items, confidences, strict=True):
        start, end = shift_to_step_middle(float(item.start_time), float(item.end_time), aligner_step(aligner))
        words.append(Word(text=item.text, start=start, end=end, confidence=confidence))
    return words


# --- Media ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AudioInfo:
    clock: FrameClock
    duration_frames: int


def _media_clock(path: str, job: JobContext) -> AudioInfo:
    info = ffprobe_json(
        [
            "-show_entries",
            "format=start_time,duration:stream=index,codec_type,r_frame_rate,time_base,start_pts:stream_disposition=attached_pic",
            path,
        ],
        job,
    )
    streams = info.get("streams") or []
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if audio is None:
        raise RpcError(NO_AUDIO, "this clip has no sound to transcribe")
    video = next(
        (
            stream
            for stream in streams
            if stream.get("codec_type") == "video" and not (stream.get("disposition") or {}).get("attached_pic")
        ),
        None,
    )

    def start_of(stream: dict[str, Any]) -> Fraction:
        time_base = timebase.parse_rational(stream.get("time_base")) or Fraction(0)
        try:
            return int(stream.get("start_pts") or 0) * time_base
        except (TypeError, ValueError):
            return Fraction(0)

    container = info.get("format") or {}
    try:
        container_start = Fraction(container.get("start_time") or "0")
    except (TypeError, ValueError):
        container_start = Fraction(0)
    try:
        duration = Fraction(container.get("duration") or "0")
    except (TypeError, ValueError):
        duration = Fraction(0)
    rate = (timebase.parse_rational(video.get("r_frame_rate")) if video else None) or Fraction(30)
    audio_start = max(Fraction(0), start_of(audio) - container_start)
    video_start = max(Fraction(0), start_of(video) - container_start) if video else Fraction(0)
    clock = FrameClock(rate=rate, audio_start=audio_start, video_start=video_start)
    return AudioInfo(clock=clock, duration_frames=timebase.seconds_to_frame(duration, rate))


def decode_audio(path: str, job: JobContext) -> np.ndarray:
    import numpy as np

    raw = run_tool(
        "ffmpeg",
        ["-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        job,
        timeout=AUDIO_DECODE_TIMEOUT,
    )
    return np.frombuffer(raw, dtype=np.float32)


# --- Cache ------------------------------------------------------------------------------------


def _cache_path(cache_dir: str, fingerprint: dict[str, Any]) -> str:
    return os.path.join(cache_dir, f"{fingerprint['sha256']}.json")


def _model_id(profile: str) -> tuple[str, str]:
    asr = models.profile_models(profile)[0]
    return asr.repo, asr.revision


def read_cache(cache_dir: str, fingerprint: dict[str, Any], profile: str | None) -> dict[str, Any] | None:
    """The cached transcript for this media, if its fingerprint matches and (when given) its model."""
    try:
        with open(_cache_path(cache_dir, fingerprint), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("transcriptVersion") != TRANSCRIPT_VERSION:
        return None
    if data.get("mediaFingerprint") != fingerprint:
        return None
    if profile is not None and (data.get("model"), data.get("revision")) != _model_id(profile):
        return None
    return data


def _summary(path: str, transcript: dict[str, Any], cached: bool) -> dict[str, Any]:
    return {
        "path": path,
        "cached": cached,
        "model": transcript["model"],
        "fps": transcript["fps"],
        "wordCount": len(transcript["words"]),
        "durationFrames": transcript["durationFrames"],
    }


def _write_cache(target: str, transcript: dict[str, Any], job: JobContext) -> None:
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the transcript folder cannot be created") from None
    partial = f"{target}.{os.getpid()}.{threading.get_ident()}.part"
    job.track_output(partial)
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(transcript, handle, ensure_ascii=False, separators=(",", ":"))
    job.raise_if_cancelled()
    os.replace(partial, target)
    job.keep_output(partial)


# --- Methods ----------------------------------------------------------------------------------


def _run(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    cache_dir = params["cacheDir"]
    fingerprint = params["fingerprint"]
    profile = params.get("model", "default")
    if not os.path.isabs(cache_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at cacheDir: must be absolute")
    media_file(path)
    target = _cache_path(cache_dir, fingerprint)
    cached = read_cache(cache_dir, fingerprint, profile)
    if cached is not None:
        return _summary(target, cached, cached=True)
    models.require_ready(profile)
    job.progress(0.0, "reading audio")
    info = _media_clock(path, job)
    pcm = decode_audio(path, job)
    # The sound levels for silence removal, from this same audio on this same clock (S7V-055).
    from .silence import frame_levels, levels_document, write_levels

    frames = frame_levels(pcm, info.clock, info.duration_frames)
    levels = levels_document(fingerprint, info.clock.rate, info.duration_frames, frames)
    chunks = plan_chunks(pcm)
    words_per_chunk: list[list[Word]] = []
    started = time.perf_counter()
    with holder().use(profile, job, LOAD_PROGRESS) as (asr, aligner):
        load_ms = round((time.perf_counter() - started) * 1000)
        step = (1 - TRANSCRIBE_FROM) / max(len(chunks), 1)
        for index, chunk in enumerate(chunks):
            at = TRANSCRIBE_FROM + index * step
            job.progress(at, "transcribing")
            piece = pcm[int(chunk.lo * SAMPLE_RATE) : int(chunk.hi * SAMPLE_RATE)]
            words = _transcribe_chunk(
                asr, aligner, piece, lambda at=at: job.progress(at + step / 2, "timing the words")
            )
            for word in words:
                word.start += chunk.lo
                word.end += chunk.lo
            words_per_chunk.append(words)
    job.raise_if_cancelled()
    words = drop_silent_words(merge_chunks(chunks, words_per_chunk), pcm)
    repo, revision = _model_id(profile)
    transcript = {
        "transcriptVersion": TRANSCRIPT_VERSION,
        "mediaFingerprint": fingerprint,
        "model": repo,
        "revision": revision,
        "fps": timebase.rational(info.clock.rate),
        "durationFrames": info.duration_frames,
        "words": words_to_frames(words, info.clock),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    # Levels first: a transcript on disk always has its levels next to it.
    write_levels(cache_dir, levels, job)
    _write_cache(target, transcript, job)
    result = _summary(target, transcript, cached=False)
    result["timings"] = {
        "loadMs": load_ms,
        "totalMs": round((time.perf_counter() - started) * 1000),
        "peakMemoryBytes": _mlx_peak_bytes(),
    }
    return result


def _mlx_peak_bytes() -> int:
    """MLX's peak Metal allocation since the last call, which the process RSS does not show."""
    try:
        import mlx.core as mx

        peak = int(mx.get_peak_memory())
        mx.reset_peak_memory()
        return peak
    except Exception:
        return 0


def _models_status(_params: dict[str, Any], _job: JobContext) -> dict[str, Any]:
    current = holder()
    return {**models.status(), "loadedProfile": current.loaded_profile}


def _models_download(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    return models.download(params["model"], job, params.get("reuse"))


FINGERPRINT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["sha256", "size"],
    "properties": {
        "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
        "size": {"type": "integer", "minimum": 0},
    },
}
PROFILE_SCHEMA = {"enum": list(models.PROFILES)}

METHODS = [
    Method(
        "transcribe.run",
        _run,
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["jobId", "path", "cacheDir", "fingerprint"],
            "properties": {
                "jobId": {"type": "string"},
                "path": PATH_SCHEMA,
                "cacheDir": PATH_SCHEMA,
                "fingerprint": FINGERPRINT_SCHEMA,
                "model": PROFILE_SCHEMA,
            },
        },
        job=True,
    ),
    Method(
        "transcribe.models.status",
        _models_status,
        {"type": "object", "additionalProperties": False, "properties": {}},
    ),
    Method(
        "transcribe.models.download",
        _models_download,
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["jobId", "model"],
            "properties": {
                "jobId": {"type": "string"},
                "model": PROFILE_SCHEMA,
                "reuse": {"enum": ["clone", "copy"]},
            },
        },
        job=True,
    ),
]
