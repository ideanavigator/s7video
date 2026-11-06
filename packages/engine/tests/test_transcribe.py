# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Transcription without the real models: chunking, merging, frames, the silence filter, the cache,
and the model download against a local fake server of tiny files. The real models run in the
`transcribe-talking-head` golden test."""

from __future__ import annotations

import errno
import hashlib
import http.server
import json
import math
import os
import threading
import wave
from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from engine_support import Wire

from s7engine import models, rpc
from s7engine.jobs import Cancelled, JobContext
from s7engine.methods import silence as silence_method
from s7engine.methods import transcribe
from s7engine.methods.transcribe import Chunk, FrameClock, Word

SR = transcribe.SAMPLE_RATE

# --- Synthetic audio --------------------------------------------------------------------------


def tone(seconds: float, dbfs: float = -12.0, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (10 ** (dbfs / 20) * math.sqrt(2) * np.sin(2 * math.pi * freq * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def speech(pattern: list[tuple[str, float]]) -> np.ndarray:
    """("s", seconds) of tone or ("p", seconds) of silence, in order."""
    return np.concatenate([tone(length) if kind == "s" else silence(length) for kind, length in pattern])


def write_wav(path: Path, pcm: np.ndarray) -> Path:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes())
    return path


# --- Tier 1: pure pipeline pieces --------------------------------------------------------------


def test_chunk_plan_starts_each_chunk_0_4s_early() -> None:
    # Ten 2.5 s phrases with 0.6 s pauses: 31 s of speech, so at least two chunks.
    pcm = speech([("p", 1.0)] + [item for _ in range(10) for item in (("s", 2.5), ("p", 0.6))])
    chunks = transcribe.plan_chunks(pcm)
    assert len(chunks) >= 2
    for chunk in chunks:
        assert chunk.hi - chunk.lo <= transcribe.MAX_CHUNK_S + 1e-9
        assert chunk.lo == pytest.approx(max(0.0, chunk.core_start - 0.4))
    # Every stretch of speech is inside the audio some chunk gets.
    for start, end in transcribe.speech_spans(pcm):
        assert any(chunk.core_start <= start and end <= chunk.core_end for chunk in chunks)


def test_long_speech_without_pauses_is_split_under_the_limit() -> None:
    pcm = speech([("s", 61.0)])
    chunks = transcribe.plan_chunks(pcm)
    assert len(chunks) == 3
    assert all(chunk.hi - chunk.lo <= transcribe.MAX_CHUNK_S for chunk in chunks)
    assert chunks[0].core_start == 0 and chunks[-1].core_end == pytest.approx(61.0)


def test_merge_dedupes_overlap_words() -> None:
    first = Chunk(lo=0.0, hi=10.4, core_start=0.4, core_end=10.0)
    second = Chunk(lo=10.3, hi=20.4, core_start=10.7, core_end=20.0)
    # "end" sits in both pieces (first's tail, second's lead); each pause belongs to one chunk.
    words = transcribe.merge_chunks(
        [first, second],
        [
            [Word("hello", 0.5, 0.9), Word("end", 9.6, 10.0)],
            [Word("end", 9.6, 10.0), Word("next", 10.75, 11.2)],
        ],
    )
    assert [(word.text, word.start) for word in words] == [("hello", 0.5), ("end", 9.6), ("next", 10.75)]


def test_word_at_chunk_start_is_kept() -> None:
    # The pause detector put the second chunk's speech at 10.7 s, but its first word starts at
    # 10.45 s (a soft onset): the 0.4 s lead gives it to the model, and the merge keeps it.
    pcm = speech([("s", 10.0), ("p", 0.7), ("s", 9.0)])
    chunks = transcribe.plan_chunks(pcm)
    assert len(chunks) == 1 or chunks[1].lo <= chunks[1].core_start - 0.4 + 1e-9
    a = Chunk(lo=0.0, hi=10.4, core_start=0.0, core_end=10.0)
    b = Chunk(lo=10.3, hi=19.7, core_start=10.7, core_end=19.7)
    words = transcribe.merge_chunks([a, b], [[Word("one", 9.0, 9.9)], [Word("Decided", 10.45, 10.9)]])
    assert [word.text for word in words] == ["one", "Decided"]


@pytest.mark.parametrize(
    ("rate", "seconds", "frame"),
    [
        (Fraction(25), Fraction(2), 50),
        (Fraction(30), Fraction(1), 30),
        (Fraction(30000, 1001), Fraction(1001, 1000), 30),
        (Fraction(30000, 1001), Fraction(10), 300),
    ],
)
def test_words_to_frames_uses_pts_timebase(rate: Fraction, seconds: Fraction, frame: int) -> None:
    clock = FrameClock(rate=rate)
    [word] = transcribe.words_to_frames([Word("x", float(seconds), float(seconds) + 0.5, 0.9)], clock)
    assert word["startFrame"] == frame
    assert isinstance(word["startFrame"], int) and isinstance(word["endFrame"], int)
    assert word["speaker"] == "S1"


def test_words_to_frames_counts_from_the_first_video_frame() -> None:
    # Audio starts 0.5 s into the media clock; video starts at 0.1 s. A word 1 s into the audio
    # is 1.4 s after the first video frame: frame 35 at 25 fps.
    clock = FrameClock(rate=Fraction(25), audio_start=Fraction(1, 2), video_start=Fraction(1, 10))
    [word] = transcribe.words_to_frames([Word("x", 1.0, 1.2)], clock)
    assert (word["startFrame"], word["endFrame"]) == (35, 40)


def test_near_silence_filter_drops_word() -> None:
    pcm = np.concatenate([tone(0.5, dbfs=-20), silence(0.5), tone(0.3, dbfs=-58)])
    words = [Word("real", 0.05, 0.45), Word("blip", 1.0, 1.3)]
    kept = transcribe.drop_silent_words(words, pcm)
    assert [word.text for word in kept] == ["real"]
    assert transcribe.word_dbfs(pcm, 1.0, 1.3) < transcribe.SILENT_WORD_DBFS


def test_word_starts_move_to_the_middle_of_the_aligner_step() -> None:
    @dataclass
    class Config:
        timestamp_segment_time: float

    @dataclass
    class Aligner:
        config: Config

    assert transcribe.aligner_step(Aligner(Config(80))) == pytest.approx(0.08)
    assert transcribe.aligner_step(Aligner(Config(40))) == pytest.approx(0.04)
    assert transcribe.aligner_step(object()) == transcribe.DEFAULT_ALIGNER_STEP_S
    # Half a step later; the end is kept, and a start never passes its end.
    assert transcribe.shift_to_step_middle(1.0, 1.5, 0.08) == pytest.approx((1.04, 1.5))
    assert transcribe.shift_to_step_middle(1.0, 1.02, 0.08) == pytest.approx((1.02, 1.02))


def test_word_confidence_is_the_geometric_mean_of_its_tokens() -> None:
    pieces = [("Greet", 0.5), ("ings", 0.5), (".", 0.9), (" I", 1.0), ("'m", 1.0), (" Xu", 0.25)]
    assert transcribe.word_confidences(pieces, ["Greetings", "I'm", "Xu", "unheard"]) == [
        pytest.approx(math.exp((math.log(0.5) * 2 + math.log(0.9)) / 3)),
        pytest.approx(1.0),
        pytest.approx(0.25),
        None,
    ]


# --- Fake model server ------------------------------------------------------------------------


@dataclass
class FakeFile:
    content: bytes
    #: Serve this many bytes, then drop the connection, the first time the file is asked for.
    drop_after: int | None = None
    #: Serve these bytes instead of `content` (a corrupt mirror).
    served: bytes | None = None
    #: Answer with a 302 to this URL instead of the file.
    redirect_to: str | None = None


class FakeHub:
    def __init__(self, files: dict[str, FakeFile]) -> None:
        self.files = files
        self.requests: list[tuple[str, str | None]] = []
        hub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                name = self.path.rsplit("/", 1)[-1]
                fake = hub.files.get(name)
                hub.requests.append((name, self.headers.get("Range")))
                if fake is None:
                    self.send_error(404)
                    return
                if fake.redirect_to is not None:
                    self.send_response(302)
                    self.send_header("Location", fake.redirect_to)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = fake.served if fake.served is not None else fake.content
                start = 0
                if self.headers.get("Range"):
                    start = int(self.headers["Range"].removeprefix("bytes=").split("-")[0])
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body) - start))
                self.end_headers()
                if fake.drop_after is not None:
                    self.wfile.write(body[start : fake.drop_after])
                    fake.drop_after = None
                    self.close_connection = True
                    return
                self.wfile.write(body[start:])

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _lock(files: dict[str, bytes]) -> dict[str, Any]:
    def entry(repo: str, names: list[str]) -> dict[str, Any]:
        return {
            "repo": repo,
            "revision": "0" * 40,
            "files": [
                {"path": name, "size": len(files[name]), "sha256": hashlib.sha256(files[name]).hexdigest()}
                for name in names
            ],
        }

    return {
        "lockVersion": 1,
        "models": {
            "asr-1.7b": entry("test/asr-big", ["big.bin", "config.json"]),
            "asr-0.6b": entry("test/asr-small", ["small.bin"]),
            "aligner-0.6b": entry("test/aligner", ["aligner.bin"]),
        },
    }


FILES = {
    "big.bin": bytes(range(256)) * 4096,  # 1 MiB, so a download takes several reads
    "config.json": b'{"model_type": "fake"}',
    "small.bin": b"small model" * 100,
    "aligner.bin": b"aligner" * 500,
}


@pytest.fixture
def hub(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeHub]:
    fake = FakeHub({name: FakeFile(content) for name, content in FILES.items()})
    lock = tmp_path / "models.lock.json"
    lock.write_text(json.dumps(_lock(FILES)))
    monkeypatch.setenv("S7_MODELS_LOCK", str(lock))
    monkeypatch.setenv("S7_MODELS_BASE_URL", fake.url)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    yield fake
    fake.close()


def _download(profile: str = "default") -> dict[str, Any]:
    return models.download(profile, JobContext("download", None))


# --- Fake models ------------------------------------------------------------------------------


class FakeTokenizer:
    def __init__(self) -> None:
        self.vocab: list[str] = ["language", " English", "<asr_text>"]

    def token(self, text: str) -> int:
        if text not in self.vocab:
            self.vocab.append(text)
        return self.vocab.index(text)

    def decode(self, tokens: list[int], skip_special_tokens: bool = True) -> str:
        return "".join(self.vocab[token] for token in tokens)


NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]


class Gate:
    """Holds the fake recogniser inside a chunk until the test lets it go."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()


class FakeASR:
    """One word per burst of tone in the chunk, named by its burst's place in the chunk."""

    def __init__(self, gate: Gate | None = None) -> None:
        self._tokenizer = FakeTokenizer()
        self.gate = gate
        self.chunks = 0

    def stream_generate(self, piece: np.ndarray) -> Iterator[tuple[int, np.ndarray]]:
        self.chunks += 1
        if self.gate is not None:
            self.gate.entered.set()
            assert self.gate.release.wait(10), "the test never released the recogniser"
        spans = transcribe.speech_spans(piece)
        texts = ["language", " English", "<asr_text>", *(" " + NAMES[i % len(NAMES)] for i in range(len(spans)))]
        for text in texts:
            token = self._tokenizer.token(text)
            row = np.full(64, -20.0)
            row[token] = math.log(0.8)
            yield token, row

    @staticmethod
    def extract_language(text: str) -> tuple[str, str]:
        return "English", text.split("<asr_text>", 1)[-1]


@dataclass
class Item:
    text: str
    start_time: float
    end_time: float


@dataclass
class Aligned:
    items: list[Item]


class FakeAligner:
    def generate(self, piece: np.ndarray, text: str, language: str) -> Aligned:
        spans = transcribe.speech_spans(piece)
        return Aligned([Item(word, start, end) for word, (start, end) in zip(text.split(), spans, strict=False)])


class Loads:
    def __init__(self, gate: Gate | None = None) -> None:
        self.count = 0
        self.released = 0
        self.gate = gate
        self.asr: FakeASR | None = None

    def loader(self, model: models.Model) -> Any:
        self.count += 1
        if "aligner" in model.repo:
            return FakeAligner()
        self.asr = FakeASR(self.gate)
        return self.asr

    def release(self) -> None:
        self.released += 1


class ManualTimer:
    """An idle timer the test fires itself, instead of waiting for real time to pass."""

    made: list[ManualTimer] = []

    def __init__(self, interval: float, callback: Any) -> None:
        self.interval = interval
        self.callback = callback
        self.daemon = False
        self.started = False
        self.cancelled = False
        ManualTimer.made.append(self)

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self) -> None:
        if not self.cancelled:
            self.callback()


@pytest.fixture
def fake_models(monkeypatch: pytest.MonkeyPatch) -> Loads:
    loads = Loads()
    monkeypatch.setattr(transcribe, "_HOLDER", models.ModelHolder(600, loader=loads.loader, release=loads.release))
    return loads


def _fingerprint(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def _run(wire: Wire, clip: Path, cache: Path, job_id: str = "t1", **extra: Any) -> dict[str, Any]:
    return wire.call(
        "transcribe.run",
        {"jobId": job_id, "path": str(clip), "cacheDir": str(cache), "fingerprint": _fingerprint(clip), **extra},
    )


@pytest.fixture
def talk(tmp_path: Path) -> Path:
    return write_wav(tmp_path / "talk.wav", speech([("p", 0.5), ("s", 0.6), ("p", 0.5), ("s", 0.8), ("p", 0.7)]))


# --- Tier 1 and 2: the method end to end with fakes --------------------------------------------


def test_transcribe_writes_frames_and_returns_a_path(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, talk: Path, tmp_path: Path
) -> None:
    _download()
    reply = _run(wire, talk, tmp_path / "cache")
    result = reply["result"]
    assert result["cached"] is False and result["wordCount"] == 2
    data = json.loads(Path(result["path"]).read_text())
    assert data["transcriptVersion"] == 1 and data["model"] == "test/asr-big"
    assert data["fps"] == {"num": 30, "den": 1}
    assert [word["text"] for word in data["words"]] == ["alpha", "bravo"]
    # 0.5 s + half of the default 80 ms aligner step (the fake has no config), at 30 fps.
    assert data["words"][0]["startFrame"] == 16
    assert data["words"][0]["confidence"] == pytest.approx(0.8)
    for word in data["words"]:
        assert all(isinstance(word[key], int) for key in ("startFrame", "endFrame"))
    # No float seconds anywhere in the cached file.
    assert "start\"" not in Path(result["path"]).read_text()


def test_transcribe_writes_levels_equal_to_silence_detect(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, talk: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S7V-055: the transcribe job measures the levels from its own audio, before the transcript."""
    _download()
    cache = tmp_path / "cache"
    levels_file = cache / f"{_fingerprint(talk)['sha256']}.levels.json"
    real_write = transcribe._write_cache
    seen: list[bool] = []

    def write_cache(target: str, transcript: dict[str, Any], job: JobContext) -> None:
        seen.append(levels_file.exists())
        real_write(target, transcript, job)

    monkeypatch.setattr(transcribe, "_write_cache", write_cache)
    result = _run(wire, talk, cache)["result"]
    assert seen == [True]  # A transcript on disk never lacks its levels.
    transcript = json.loads(Path(result["path"]).read_text())
    levels = json.loads(levels_file.read_text())
    detected = wire.call("silence.detect", {"jobId": "d", "path": str(talk)})["result"]
    assert levels["levels"] == detected["levels"]
    assert levels["fps"] == transcript["fps"] == detected["rate"]
    assert levels["durationFrames"] == transcript["durationFrames"] == detected["durationFrames"]
    assert levels["mediaFingerprint"] == transcript["mediaFingerprint"]
    assert silence_method.read_levels(str(cache), _fingerprint(talk)) == levels


def test_progress_moves_through_model_load_and_word_timing(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, talk: Path, tmp_path: Path
) -> None:
    """S7V-058: a cold run no longer sits at "loading model, 0%" for most of its time."""
    _download()
    assert "result" in _run(wire, talk, tmp_path / "cache")
    reports = [
        (m["params"]["progress"], m["params"]["stage"])
        for m in wire.messages
        if m.get("method") == "progress" and m["params"]["jobId"] == "t1"
    ]
    assert [value for value, _ in reports] == sorted(value for value, _ in reports)
    stages = [stage for _, stage in reports]
    assert stages[0] == "reading audio"
    assert {"loading the speech model", "transcribing", "timing the words"} <= set(stages)
    loading = [value for value, stage in reports if stage == "loading the speech model"]
    assert len(loading) == 2 and 0 < loading[0] < loading[1]
    assert max(value for value, stage in reports if stage == "timing the words") > loading[-1]


def test_cache_hit_skips_model_load(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, talk: Path, tmp_path: Path
) -> None:
    _download()
    first = _run(wire, talk, tmp_path / "cache", "a")["result"]
    assert fake_models.count == 2
    transcribe.holder().unload()
    second = _run(wire, talk, tmp_path / "cache", "b")["result"]
    assert second["cached"] is True and second["path"] == first["path"]
    assert fake_models.count == 2  # Not loaded again.


def test_changed_model_invalidates_the_cache(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, talk: Path, tmp_path: Path
) -> None:
    _download("default")
    _download("light")
    _run(wire, talk, tmp_path / "cache", "a")
    light = _run(wire, talk, tmp_path / "cache", "b", model="light")["result"]
    assert light["cached"] is False and light["model"] == "test/asr-small"


def test_silent_audio_returns_no_words(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, tmp_path: Path
) -> None:
    _download()
    clip = write_wav(tmp_path / "quiet.wav", silence(3.0))
    result = _run(wire, clip, tmp_path / "cache")["result"]
    assert result["wordCount"] == 0


def test_missing_model_returns_models_missing(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, talk: Path, tmp_path: Path
) -> None:
    reply = _run(wire, talk, tmp_path / "cache")
    assert reply["error"]["code"] == models.MODELS_MISSING
    assert "press Download speech model in the Editor panel" in reply["error"]["message"]
    assert reply["error"]["data"] == {"profile": "default"}
    assert fake_models.count == 0


def test_cancel_transcription_job(
    hub: FakeHub, tools: None, wire: Wire, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _download()
    gate = Gate()
    loads = Loads(gate)
    monkeypatch.setattr(transcribe, "_HOLDER", models.ModelHolder(600, loader=loads.loader, release=loads.release))
    # Forty pause-separated phrases: several chunks.
    pattern = [item for _ in range(40) for item in (("s", 0.5), ("p", 0.3))]
    long_talk = write_wav(tmp_path / "long.wav", speech(pattern))
    cache = tmp_path / "cache"
    request = wire.request(
        "transcribe.run",
        {"jobId": "slow", "path": str(long_talk), "cacheDir": str(cache), "fingerprint": _fingerprint(long_talk)},
    )
    assert gate.entered.wait(10)
    assert wire.call("job.cancel", {"jobId": "slow"})["result"] == {"cancelled": True}
    gate.release.set()
    reply = wire.reply(request)
    assert reply["error"]["code"] == rpc.CANCELLED
    # The job stopped at the next chunk boundary: the first chunk was the only one recognised.
    assert loads.asr is not None and loads.asr.chunks == 1
    assert len(transcribe.plan_chunks(transcribe.decode_audio(str(long_talk), JobContext("p", None)))) > 1
    assert not cache.exists() or list(cache.iterdir()) == []


def test_video_without_audio_stream(
    hub: FakeHub, fake_models: Loads, tools: None, wire: Wire, clips: dict[str, Path], tmp_path: Path
) -> None:
    _download()
    reply = _run(wire, clips["grey"], tmp_path / "cache")
    assert reply["error"]["code"] == transcribe.NO_AUDIO
    assert reply["error"]["message"] == "this clip has no sound to transcribe"


def test_idle_unload(monkeypatch: pytest.MonkeyPatch) -> None:
    loads = Loads()
    ManualTimer.made = []
    holder = models.ModelHolder(600, loader=loads.loader, release=loads.release, timer=ManualTimer)
    job = JobContext("x", None)
    pair = [models.Model("a", "test/asr", "r", ()), models.Model("b", "test/aligner", "r", ())]
    monkeypatch.setattr(models, "require_ready", lambda _profile: pair)
    with holder.use("default", job):
        pass
    assert holder.loaded_profile == "default"
    [timer] = ManualTimer.made
    assert (timer.interval, timer.started, timer.daemon) == (600, True, True)
    # Used again before the timeout: that timer is cancelled and a new one starts.
    with holder.use("default", job):
        pass
    assert timer.cancelled and len(ManualTimer.made) == 2 and loads.count == 2
    ManualTimer.made[-1].fire()
    assert holder.loaded_profile is None and loads.released == 1


# --- Model download --------------------------------------------------------------------------


def test_download_verifies_and_reports_status(hub: FakeHub) -> None:
    before = models.status()
    assert before["profiles"]["default"] == {
        "models": ["asr-1.7b", "aligner-0.6b"],
        "sizeBytes": len(FILES["big.bin"]) + len(FILES["config.json"]) + len(FILES["aligner.bin"]),
        "ready": False,
        "found": None,
    }
    progress: list[float] = []
    result = models.download("default", JobContext("d", lambda value, _stage: progress.append(value)))
    assert result["ready"] is True
    assert progress[-1] == 1.0 and progress == sorted(progress)
    after = models.status()
    assert after["profiles"]["default"]["ready"] is True
    assert after["profiles"]["light"]["ready"] is False
    folder = models.snapshot_dir(models.load_lock()["asr-1.7b"])
    assert (folder / "big.bin").read_bytes() == FILES["big.bin"]
    assert (folder.parent.parent / "refs" / "main").read_text() == "0" * 40


def test_two_downloads_at_once_share_the_files(hub: FakeHub) -> None:
    results: list[dict[str, Any]] = []
    threads = [threading.Thread(target=lambda: results.append(_download())) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert [result["ready"] for result in results] == [True, True]
    assert sum(1 for name, _range in hub.requests if name == "big.bin") == 1
    folder = models.snapshot_dir(models.load_lock()["asr-1.7b"])
    assert (folder / "big.bin").read_bytes() == FILES["big.bin"]


def test_bad_checksum_rejected(hub: FakeHub) -> None:
    hub.files["aligner.bin"].served = b"X" * len(FILES["aligner.bin"])
    with pytest.raises(rpc.RpcError) as caught:
        _download()
    assert caught.value.code == models.CHECKSUM_MISMATCH
    folder = models.snapshot_dir(models.load_lock()["aligner-0.6b"])
    assert not (folder / "aligner.bin").exists() and not (folder / "aligner.bin.part").exists()
    assert models.status()["profiles"]["default"]["ready"] is False


def test_download_resumes_after_interrupt(hub: FakeHub) -> None:
    hub.files["big.bin"].drop_after = 300_000
    with pytest.raises(rpc.RpcError) as caught:
        _download()
    assert caught.value.code == models.DOWNLOAD_FAILED
    partial = models.snapshot_dir(models.load_lock()["asr-1.7b"]) / "big.bin.part"
    assert partial.stat().st_size == 300_000
    assert models.status()["models"]["asr-1.7b"]["downloadedBytes"] == 300_000
    _download()
    assert ("big.bin", "bytes=300000-") in hub.requests
    assert models.status()["profiles"]["default"]["ready"] is True


def test_cancelled_download_keeps_its_partial_file(hub: FakeHub) -> None:
    job = JobContext("d", None)
    seen: list[float] = []

    def cancel_midway(value: float, _stage: str | None) -> None:
        seen.append(value)
        if 0 < value < 1:
            job.cancel()

    job._send_progress = cancel_midway
    hub.files["big.bin"].drop_after = None
    with pytest.raises(Cancelled):
        models.download("default", job)
    assert models.status()["profiles"]["default"]["ready"] is False


def test_disk_full_before_download(hub: FakeHub, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(models.shutil, "disk_usage", lambda _path: type("U", (), {"free": 1024})())
    with pytest.raises(rpc.RpcError) as caught:
        _download()
    assert caught.value.code == models.DISK_FULL


def test_disk_full_during_download(hub: FakeHub, monkeypatch: pytest.MonkeyPatch) -> None:
    def full(_handle: Any, _chunk: bytes) -> None:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(models, "_write", full)
    with pytest.raises(rpc.RpcError) as caught:
        _download()
    assert caught.value.code == models.DISK_FULL
    assert caught.value.message == "the disk filled up during the speech model download"
    assert not (models.snapshot_dir(models.load_lock()["asr-1.7b"]) / "big.bin.part").exists()


def test_offline_download_fails_with_a_plain_message(hub: FakeHub, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_MODELS_BASE_URL", "http://127.0.0.1:9")
    with pytest.raises(rpc.RpcError) as caught:
        _download()
    assert caught.value.code == models.DOWNLOAD_FAILED
    assert "check the connection" in caught.value.message


def test_redirect_to_another_plain_http_origin_is_refused(hub: FakeHub) -> None:
    other = FakeHub({"elsewhere.bin": FakeFile(FILES["big.bin"])})
    try:
        hub.files["big.bin"].redirect_to = f"{other.url}/elsewhere.bin"
        with pytest.raises(rpc.RpcError) as caught:
            _download()
        assert caught.value.code == models.DOWNLOAD_FAILED
        assert caught.value.message == "the speech model download was redirected to an insecure address"
        assert other.requests == []
        folder = models.snapshot_dir(models.load_lock()["asr-1.7b"])
        assert not (folder / "big.bin").exists()
    finally:
        other.close()


def test_redirect_within_the_same_origin_is_followed(hub: FakeHub) -> None:
    hub.files["mirror.bin"] = FakeFile(FILES["big.bin"])
    hub.files["big.bin"].redirect_to = f"{hub.url}/cdn/mirror.bin"
    _download()
    assert models.status()["profiles"]["default"]["ready"] is True
    assert ("mirror.bin", None) in hub.requests


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("path", "../outside.bin"),
        ("path", "sub/../../outside.bin"),
        ("path", "/etc/outside.bin"),
        ("path", ""),
        ("path", "a\\b.bin"),
        ("repo", "test/../asr"),
        ("repo", "/abs/asr"),
        ("revision", "main"),
        ("sha256", "not-a-hash"),
    ],
)
def test_lock_with_unsafe_entries_is_refused(
    hub: FakeHub, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: str
) -> None:
    lock = _lock(FILES)
    entry = lock["models"]["asr-1.7b"]
    if field in ("path", "sha256"):
        entry["files"][0][field] = value
    else:
        entry[field] = value
    bad = tmp_path / "bad.lock.json"
    bad.write_text(json.dumps(lock))
    monkeypatch.setenv("S7_MODELS_LOCK", str(bad))
    for attempt in (models.status, _download):
        with pytest.raises(rpc.RpcError) as caught:
            attempt()
        assert caught.value.message == "the speech model list is invalid"
    assert hub.requests == []
    assert not (tmp_path / "outside.bin").exists()


def test_shipped_lock_pins_every_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("S7_MODELS_LOCK", raising=False)
    lock = models.load_lock()
    assert set(lock) == {"asr-1.7b", "asr-0.6b", "aligner-0.6b"}
    for model in lock.values():
        assert len(model.revision) == 40 and model.repo.startswith("mlx-community/")
        assert all(len(file.sha256) == 64 for file in model.files)
    default = sum(lock[key].size for key in models.PROFILES["default"])
    light = sum(lock[key].size for key in models.PROFILES["light"])
    assert 3.7e9 < default < 3.8e9 and 2.2e9 < light < 2.35e9


# --- Reusing a copy from another Hugging Face cache (S7V-067) ---------------------------------


def _fake_cache(root: Path, *, revision: str = "0" * 40, skip: str | None = None, corrupt: str | None = None) -> Path:
    """The Hub cache layout: snapshot entries are symlinks into `blobs/`, as `huggingface_hub` writes."""
    repos = {"test/asr-big": ["big.bin", "config.json"], "test/asr-small": ["small.bin"], "test/aligner": ["aligner.bin"]}
    for repo, names in repos.items():
        base = root / f"models--{repo.replace('/', '--')}"
        (base / "blobs").mkdir(parents=True, exist_ok=True)
        snapshot = base / "snapshots" / revision
        snapshot.mkdir(parents=True, exist_ok=True)
        for name in names:
            if name == skip:
                continue
            content = FILES[name] if name != corrupt else b"X" * len(FILES[name])
            blob = base / "blobs" / hashlib.sha256(content).hexdigest()
            blob.write_bytes(content)
            (snapshot / name).symlink_to(blob)
    return root


@pytest.fixture
def cache(hub: FakeHub, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "user-cache" / "hub"
    monkeypatch.setenv("S7_HF_CACHE_DIRS", json.dumps([str(root)]))
    return root


def _snapshot_bytes(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def test_status_finds_a_matching_copy_and_reuse_clones_it(cache: Path, hub: FakeHub) -> None:
    _fake_cache(cache)
    before = _snapshot_bytes(cache)
    found = models.status()["profiles"]["default"]["found"]
    assert found == {"copyBytes": 0}  # same volume: a clone, no extra space
    progress: list[float] = []
    stages: set[str | None] = set()

    def seen(value: float, stage: str | None) -> None:
        progress.append(value)
        stages.add(stage)

    result = models.download("default", JobContext("r", seen), "clone")
    assert result["ready"] is True and progress[-1] == 1.0
    assert stages == {"checking the copy on this Mac", "verified"}
    after = models.status()
    assert after["profiles"]["default"]["ready"] is True and after["profiles"]["default"]["found"] is None
    folder = models.snapshot_dir(models.load_lock()["asr-1.7b"])
    assert (folder / "big.bin").read_bytes() == FILES["big.bin"] and not (folder / "big.bin").is_symlink()
    assert hub.requests == []  # nothing from the network
    assert _snapshot_bytes(cache) == before  # the other cache is only read


def test_a_copy_with_a_wrong_hash_is_refused_and_leaves_nothing(cache: Path) -> None:
    _fake_cache(cache, corrupt="aligner.bin")
    # Sizes match, so it is offered; the sha256 check on Use refuses it.
    assert models.status()["profiles"]["default"]["found"] == {"copyBytes": 0}
    with pytest.raises(rpc.RpcError) as caught:
        models.download("default", JobContext("r", None), "clone")
    assert caught.value.code == models.CACHE_MISMATCH
    folder = models.snapshot_dir(models.load_lock()["aligner-0.6b"])
    assert list(folder.glob("*")) == []
    assert models.status()["profiles"]["default"]["ready"] is False


def test_a_partial_copy_or_another_revision_is_not_offered(cache: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_cache(cache, skip="config.json")
    assert models.status()["profiles"]["default"]["found"] is None
    assert models.status()["profiles"]["light"]["found"] == {"copyBytes": 0}
    other = tmp_path / "other" / "hub"
    _fake_cache(other, revision="1" * 40)
    monkeypatch.setenv("S7_HF_CACHE_DIRS", json.dumps([str(other)]))
    assert models.status()["profiles"]["light"]["found"] is None
    with pytest.raises(rpc.RpcError) as caught:
        models.download("light", JobContext("r", None), "clone")
    assert caught.value.code == models.CACHE_MISMATCH


def _relink(cache: Path, repo: str, name: str, target: Path) -> None:
    """Point one snapshot entry at `target`, a file with the right bytes (so size and sha256 match)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(FILES[name])
    entry = cache / f"models--{repo.replace('/', '--')}" / "snapshots" / ("0" * 40) / name
    entry.unlink()
    entry.symlink_to(target)


def test_a_link_outside_blobs_is_not_offered(cache: Path, tmp_path: Path) -> None:
    """S7V-068: only the model's own `blobs/` folder counts, even for a file of the right size and hash."""
    _fake_cache(cache)
    _relink(cache, "test/aligner", "aligner.bin", tmp_path / "elsewhere" / "aligner.bin")
    profiles = models.status()["profiles"]
    assert profiles["default"]["found"] is None and profiles["light"]["found"] is None


def test_reuse_refuses_a_link_outside_blobs_and_leaves_nothing(
    cache: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_cache(cache)
    _relink(cache, "test/aligner", "aligner.bin", tmp_path / "elsewhere" / "aligner.bin")
    read: list[Path] = []
    monkeypatch.setattr(models, "_clonefile", lambda source, _target: read.append(source) or False)
    for mode in ("clone", "copy"):
        with pytest.raises(rpc.RpcError) as caught:
            models.download("light", JobContext("r", None), mode)
        assert caught.value.code == models.CACHE_MISMATCH
    assert read == []  # refused before any file is read
    lock = models.load_lock()
    for key in ("asr-0.6b", "aligner-0.6b"):
        folder = models.snapshot_dir(lock[key])
        assert not folder.exists() or list(folder.rglob("*")) == []
    assert models.status()["profiles"]["light"]["ready"] is False


def test_a_link_into_another_models_blobs_is_not_offered(cache: Path) -> None:
    _fake_cache(cache)
    other = cache / "models--test--asr-small" / "blobs" / hashlib.sha256(FILES["aligner.bin"]).hexdigest()
    _relink(cache, "test/aligner", "aligner.bin", other)
    assert models.status()["profiles"]["light"]["found"] is None
    with pytest.raises(rpc.RpcError) as caught:
        models.download("light", JobContext("r", None), "clone")
    assert caught.value.code == models.CACHE_MISMATCH


def _assert_refused_unread(monkeypatch: pytest.MonkeyPatch) -> None:
    """Not offered, and reuse in either mode is refused before any file is read."""
    assert models.status()["profiles"]["light"]["found"] is None
    read: list[Path] = []

    def opened(source: Path, _size: int) -> Any:
        read.append(source)
        raise AssertionError("a refused copy was opened")

    monkeypatch.setattr(models, "_open_blob", opened)
    for mode in ("clone", "copy"):
        with pytest.raises(rpc.RpcError) as caught:
            models.download("light", JobContext("r", None), mode)
        assert caught.value.code == models.CACHE_MISMATCH
    assert read == []
    folder = models.snapshot_dir(models.load_lock()["aligner-0.6b"])
    assert not folder.exists() or list(folder.rglob("*")) == []


def test_a_blobs_folder_linked_outside_the_cache_is_not_offered(
    cache: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review of S7V-068: `blobs/` itself is a link, so its entries resolve outside the cache."""
    _fake_cache(cache)
    blobs = cache / "models--test--aligner" / "blobs"
    outside = tmp_path / "outside" / "blobs"
    outside.parent.mkdir(parents=True)
    blobs.rename(outside)
    blobs.symlink_to(outside, target_is_directory=True)
    _assert_refused_unread(monkeypatch)


def test_a_blobs_folder_linked_into_another_model_is_not_offered(cache: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_cache(cache)
    blobs = cache / "models--test--aligner" / "blobs"
    other = cache / "models--test--asr-small" / "blobs"
    for blob in blobs.iterdir():
        blob.rename(other / blob.name)
    blobs.rmdir()
    blobs.symlink_to(other, target_is_directory=True)
    _assert_refused_unread(monkeypatch)


def test_a_linked_model_folder_is_not_offered(cache: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_cache(cache)
    base = cache / "models--test--aligner"
    outside = tmp_path / "outside" / base.name
    outside.parent.mkdir(parents=True)
    base.rename(outside)
    base.symlink_to(outside, target_is_directory=True)
    _assert_refused_unread(monkeypatch)


@pytest.mark.parametrize("swap", ["link", "directory", "fifo", "linked-folder"])
def test_a_blob_swapped_after_the_check_is_refused_when_opened(cache: Path, tmp_path: Path, swap: str) -> None:
    """Review of S7V-068: clone and copy both read one open of the checked blob, which follows no
    link in any part of the path, never waits on a FIFO and must be a regular file."""
    _fake_cache(cache)
    blob = models.cached_snapshot(models.load_lock()["aligner-0.6b"])["aligner.bin"]  # type: ignore[index]
    planted = tmp_path / "outside" / blob.name
    planted.parent.mkdir()
    planted.write_bytes(FILES["aligner.bin"])
    if swap == "linked-folder":
        blob.parent.rename(tmp_path / "moved-blobs")
        blob.parent.symlink_to(planted.parent, target_is_directory=True)
    else:
        blob.unlink()
        if swap == "link":
            blob.symlink_to(planted)
        elif swap == "directory":
            blob.mkdir()
            (blob / "inner.bin").write_bytes(FILES["aligner.bin"])
        else:
            os.mkfifo(blob)
    with pytest.raises(rpc.RpcError) as caught:
        models._open_blob(blob, len(FILES["aligner.bin"]))
    assert caught.value.code == models.CACHE_MISMATCH


def _shared_store_cache(root: Path) -> Path:
    """huggingface_hub 2.x with the shared Xet store: snapshot entry -> `../../blobs/<etag>` (the
    model's own blobs) -> `../../blobs/<2 hex>/<hash>` (the cache-wide store), all relative links."""
    repos = {"test/asr-big": ["big.bin", "config.json"], "test/asr-small": ["small.bin"], "test/aligner": ["aligner.bin"]}
    store = root / "blobs"
    store.mkdir(parents=True, exist_ok=True)
    (store / ".huggingface-shared-blobs").write_text("", encoding="utf-8")
    for repo, names in repos.items():
        base = root / f"models--{repo.replace('/', '--')}"
        (base / "blobs").mkdir(parents=True, exist_ok=True)
        snapshot = base / "snapshots" / ("0" * 40)
        snapshot.mkdir(parents=True, exist_ok=True)
        for name in names:
            digest = hashlib.sha256(FILES[name]).hexdigest()
            (store / digest[:2]).mkdir(exist_ok=True)
            (store / digest[:2] / digest).write_bytes(FILES[name])
            etag = hashlib.sha1(FILES[name]).hexdigest()
            (base / "blobs" / etag).symlink_to(f"../../blobs/{digest[:2]}/{digest}")
            (snapshot / name).symlink_to(f"../../blobs/{etag}")
    return root


@pytest.mark.parametrize("mode", ["clone", "copy"])
def test_a_shared_store_cache_is_found_and_reused(cache: Path, hub: FakeHub, monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    """Review of S7V-068 round 2: the PO's real cache uses this layout for every pinned model."""
    _shared_store_cache(cache)
    assert models.status()["profiles"]["default"]["found"] == {"copyBytes": 0}
    if mode == "copy":
        monkeypatch.setattr(models, "_clonefile", lambda _source, _target: False)
    models.download("default", JobContext("r", None), mode)
    assert models.status()["profiles"]["default"]["ready"] is True
    folder = models.snapshot_dir(models.load_lock()["asr-1.7b"])
    assert (folder / "big.bin").read_bytes() == FILES["big.bin"] and not (folder / "big.bin").is_symlink()
    assert hub.requests == []


def test_a_shared_store_linked_outside_the_cache_is_not_offered(
    cache: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _shared_store_cache(cache)
    store = cache / "blobs"
    outside = tmp_path / "outside" / "blobs"
    outside.parent.mkdir(parents=True)
    store.rename(outside)
    store.symlink_to(outside, target_is_directory=True)
    _assert_refused_unread(monkeypatch)


def test_a_store_entry_linked_out_of_the_store_is_not_offered(
    cache: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The model's blob links into the store, but that store entry links out of the cache."""
    _shared_store_cache(cache)
    digest = hashlib.sha256(FILES["aligner.bin"]).hexdigest()
    entry = cache / "blobs" / digest[:2] / digest
    planted = tmp_path / "outside" / "aligner.bin"
    planted.parent.mkdir(parents=True)
    planted.write_bytes(FILES["aligner.bin"])
    entry.unlink()
    entry.symlink_to(planted)
    _assert_refused_unread(monkeypatch)


def test_a_snapshot_entry_straight_into_the_store_is_not_offered(cache: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A store file is accepted only when reached through the model's own `blobs/` entry."""
    _shared_store_cache(cache)
    digest = hashlib.sha256(FILES["aligner.bin"]).hexdigest()
    entry = cache / "models--test--aligner" / "snapshots" / ("0" * 40) / "aligner.bin"
    entry.unlink()
    entry.symlink_to(f"../../../blobs/{digest[:2]}/{digest}")
    assert entry.read_bytes() == FILES["aligner.bin"]
    _assert_refused_unread(monkeypatch)


def _blobs_on_another_disk(monkeypatch: pytest.MonkeyPatch, cache: Path) -> None:
    """The blobs the cache's symlinks point to look like another volume (an external disk)."""
    real = models._file_device

    def device(path: Path) -> int:
        return -1 if Path(os.path.realpath(path)).is_relative_to(cache.resolve()) else real(path)

    monkeypatch.setattr(models, "_file_device", device)


def test_a_copy_on_another_disk_says_its_size_and_copies_only_when_allowed(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_cache(cache)
    _blobs_on_another_disk(monkeypatch, cache)
    light = len(FILES["small.bin"]) + len(FILES["aligner.bin"])
    assert models.status()["profiles"]["light"]["found"] == {"copyBytes": light}
    clones: list[Path] = []
    monkeypatch.setattr(models, "_clonefile", lambda source, _target: clones.append(source) or False)
    # Without the user's yes to the space, nothing is cloned or copied.
    with pytest.raises(rpc.RpcError) as caught:
        models.download("light", JobContext("r", None), "clone")
    assert caught.value.code == models.CACHE_NEEDS_COPY and clones == []
    assert list(models.snapshot_dir(models.load_lock()["asr-0.6b"]).parent.rglob("*.reuse")) == []
    # Not enough free space: refused before any copy.
    real_usage = models.shutil.disk_usage
    monkeypatch.setattr(models.shutil, "disk_usage", lambda _path: type("U", (), {"free": 1024})())
    with pytest.raises(rpc.RpcError) as full:
        models.download("light", JobContext("r", None), "copy")
    assert full.value.code == models.DISK_FULL and clones == []
    monkeypatch.setattr(models.shutil, "disk_usage", real_usage)
    models.download("light", JobContext("r", None), "copy")
    assert models.status()["profiles"]["light"]["ready"] is True


def test_a_refused_clone_never_turns_into_a_silent_copy(cache: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`clonefile(2)` fails instead of copying (EXDEV, ENOTSUP); a refusal is not papered over."""
    _fake_cache(cache)

    class Refusing:
        @staticmethod
        def fclonefileat(_source: int, _dirfd: int, _target: bytes, _flags: int) -> int:
            return -1

    monkeypatch.setattr(models, "_LIBSYSTEM", Refusing())
    with pytest.raises(rpc.RpcError) as caught:
        models.download("light", JobContext("r", None), "clone")
    assert caught.value.code == models.CACHE_NEEDS_COPY
    folder = models.snapshot_dir(models.load_lock()["asr-0.6b"])
    assert not (folder / "small.bin").exists() and list(folder.glob("*.reuse")) == []


def test_the_real_clonefile_clones_a_blob_through_its_symlink(cache: Path) -> None:
    """The snapshot entry's link is resolved and checked first; the open, checked blob is cloned
    (`fclonefileat`). The link itself is never opened."""
    _fake_cache(cache)
    entry = cache / "models--test--asr-small" / "snapshots" / ("0" * 40) / "small.bin"
    blob = models.cached_snapshot(models.load_lock()["asr-0.6b"])["small.bin"]  # type: ignore[index]
    assert blob == Path(os.path.realpath(entry))
    target = cache.parent / "clone.bin"
    with models._open_blob(blob, len(FILES["small.bin"])) as reader:
        assert models._clonefile(reader.fileno(), target) is True
    assert target.read_bytes() == FILES["small.bin"] and not target.is_symlink()
    with pytest.raises(rpc.RpcError) as caught:
        models._open_blob(entry, len(FILES["small.bin"]))
    assert caught.value.code == models.CACHE_MISMATCH


def test_cancel_during_a_copy_leaves_nothing_behind(cache: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_cache(cache)
    _blobs_on_another_disk(monkeypatch, cache)
    monkeypatch.setattr(models, "_clonefile", lambda _source, _target: False)
    job = JobContext("r", None)
    written: list[int] = []

    def write_then_cancel(handle: Any, chunk: bytes) -> None:
        handle.write(chunk)
        written.append(len(chunk))
        job.cancel()

    monkeypatch.setattr(models, "_write", write_then_cancel)
    with pytest.raises(Cancelled):
        models.download("light", job, "copy")
    assert written == [len(FILES["small.bin"])]
    folder = models.snapshot_dir(models.load_lock()["asr-0.6b"])
    assert list(folder.glob("*")) == []
    assert models.status()["profiles"]["light"]["ready"] is False


def test_our_own_folder_and_relative_paths_are_never_searched(hub: FakeHub, monkeypatch: pytest.MonkeyPatch) -> None:
    own = Path(os.environ["HF_HOME"]) / "hub"
    _fake_cache(own)
    monkeypatch.setenv("S7_HF_CACHE_DIRS", json.dumps([str(own), "relative/hub"]))
    assert models.status()["profiles"]["default"]["found"] is None
