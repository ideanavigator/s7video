# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`silence.detect`: per-frame sound levels on the transcript's frame clock (S7V-027), summed in
blocks and cached next to the transcript (S7V-055)."""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import threading
import time
import tracemalloc
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from engine_support import FFMPEG, Wire, make_clip

from s7engine import rpc, timebase
from s7engine.jobs import JobContext
from s7engine.methods import silence, transcribe
from s7engine.methods.transcribe import SAMPLE_RATE, FrameClock

RATE = Fraction(30)


def tone(seconds: float, dbfs: float) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (10 ** (dbfs / 20) * math.sqrt(2) * np.sin(2 * math.pi * 220 * t)).astype(np.float32)


def test_frame_levels_measure_each_frame() -> None:
    pcm = np.concatenate([tone(1, -12), np.zeros(SAMPLE_RATE, dtype=np.float32), tone(1, -30)])
    levels = silence.frame_levels(pcm, FrameClock(rate=RATE), 90)
    assert len(levels) == 90 and all(isinstance(level, int) for level in levels)
    assert set(levels[:30]) == {-12}
    assert set(levels[30:60]) == {silence.FLOOR_DB}
    assert set(levels[60:]) == {-30}


def test_frame_levels_follow_the_video_clock() -> None:
    # Sound that starts half a second after the first video frame: those frames have none.
    pcm = tone(1, -12)
    levels = silence.frame_levels(pcm, FrameClock(rate=RATE, audio_start=Fraction(1, 2)), 45)
    assert set(levels[:15]) == {silence.FLOOR_DB}
    assert set(levels[15:45]) == {-12}
    # Past the end of the sound reads as the floor, not as an error.
    assert silence.frame_levels(pcm, FrameClock(rate=RATE), 40)[30:] == [silence.FLOOR_DB] * 10
    assert silence.frame_levels(pcm, FrameClock(rate=RATE), 0) == []


@pytest.mark.usefixtures("tools")
def test_silence_detect_reads_a_clip(tmp_path: Path) -> None:
    # One second of tone, one of silence, at 29.97 fps: the rate the transcript uses.
    clip = make_clip(
        tmp_path / "beep.mp4",
        "testsrc2=s=64x64:r=30000/1001:d=2",
        [
            "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1,apad=pad_dur=1",
            "-c:v", "mpeg4", "-c:a", "aac", "-t", "2",
        ],
    )
    engine = Wire()
    try:
        reply = engine.call("silence.detect", {"jobId": "d1", "path": str(clip)})
    finally:
        engine.close()
    result = reply["result"]
    assert result["rate"] == {"num": 30000, "den": 1001}
    assert result["durationFrames"] == len(result["levels"]) == 60
    assert max(result["levels"][2:27]) - min(result["levels"][2:27]) <= 1
    assert result["levels"][2] > -30
    assert max(result["levels"][34:58]) <= -80


def test_silence_detect_rejects_bad_params() -> None:
    engine = Wire()
    try:
        assert engine.call("silence.detect", {"jobId": "a"})["error"]["code"] == -32602
        assert engine.call("silence.detect", {"jobId": "b", "path": "relative.mp4"})["error"]["code"] == -32602
        # A job: without a jobId it is refused.
        assert engine.call("silence.detect", {"path": "/tmp/clip.mp4"})["error"]["code"] == -32602
    finally:
        engine.close()


# --- S7V-055: blockwise sums and the levels cache ----------------------------------------------


def whole_clip_levels(pcm: np.ndarray, clock: FrameClock, duration_frames: int) -> list[int]:
    """The S7V-027 measurement: one float64 copy, squares and `cumsum` of the whole clip."""
    edges = np.empty(duration_frames + 1, dtype=np.int64)
    offset = clock.video_start - clock.audio_start
    for index in range(duration_frames + 1):
        edges[index] = round((offset + timebase.frame_to_seconds(index, clock.rate)) * SAMPLE_RATE)
    edges = np.clip(edges, 0, len(pcm))
    counts = np.diff(edges)
    energy = np.concatenate(([0.0], np.cumsum(pcm.astype(np.float64) ** 2)))
    sums = energy[edges[1:]] - energy[edges[:-1]]
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)
        db = np.where(mean > 0, 10 * np.log10(np.maximum(mean, 1e-30)), silence.FLOOR_DB)
    return [int(value) for value in np.clip(np.rint(db), silence.FLOOR_DB, 0)]


@pytest.mark.parametrize("block", [1, 7, 533, 16_000, 1 << 20])
@pytest.mark.parametrize(
    "clock",
    [FrameClock(rate=RATE), FrameClock(rate=Fraction(30000, 1001), audio_start=Fraction(1, 3))],
    ids=["30", "29.97-late-audio"],
)
def test_blockwise_frame_levels_match_the_whole_clip_sums(block: int, clock: FrameClock) -> None:
    rng = np.random.default_rng(55)
    noise = (rng.standard_normal(SAMPLE_RATE) * 0.05).astype(np.float32)
    pcm = np.concatenate([tone(1.3, -12), np.zeros(SAMPLE_RATE // 2, dtype=np.float32), noise, tone(0.7, -41)])
    frames = 110  # Past the end of the sound, so the floor frames are covered too.
    assert silence.frame_levels(pcm, clock, frames, block) == whole_clip_levels(pcm, clock, frames)


def test_blockwise_frame_levels_on_empty_audio() -> None:
    assert silence.frame_levels(np.zeros(0, dtype=np.float32), FrameClock(rate=RATE), 3) == [silence.FLOOR_DB] * 3


def _fingerprint(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


@pytest.fixture
def beep(tmp_path: Path) -> Path:
    return make_clip(
        tmp_path / "beep.mp4",
        "testsrc2=s=64x64:r=30000/1001:d=2",
        ["-f", "lavfi", "-i", "sine=f=440:r=48000:d=1,apad=pad_dur=1", "-c:v", "mpeg4", "-c:a", "aac", "-t", "2"],
    )


def _detect(engine: Wire, clip: Path, cache: Path, job_id: str, fingerprint: dict[str, Any] | None = None) -> Any:
    return engine.call(
        "silence.detect",
        {"jobId": job_id, "path": str(clip), "cacheDir": str(cache), "fingerprint": fingerprint or _fingerprint(clip)},
    )


@pytest.mark.usefixtures("tools")
def test_silence_detect_writes_the_levels_file(beep: Path, tmp_path: Path) -> None:
    cache = tmp_path / "transcripts"
    engine = Wire()
    try:
        first = _detect(engine, beep, cache, "a")["result"]
        file = cache / f"{_fingerprint(beep)['sha256']}.levels.json"
        data = json.loads(file.read_text())
        assert data == {
            "levelsVersion": 1,
            "mediaFingerprint": _fingerprint(beep),
            "fps": {"num": 30000, "den": 1001},
            "durationFrames": 60,
            "levels": first["levels"],
        }
        assert [path.name for path in cache.iterdir()] == [file.name]
        progress = [m["params"]["stage"] for m in engine.messages if m.get("method") == "progress"]
        assert progress and set(progress) == {"measuring the sound"}
    finally:
        engine.close()


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize("damage", ["frames", "fps", "truncated"])
def test_silence_detect_always_measures_and_replaces_the_file(beep: Path, tmp_path: Path, damage: str) -> None:
    """The server starts the job only when it rejected the file (it checks it against the
    transcript), so the job never answers from it: a well-formed file for another frame count or
    rate is measured again and replaced (S7V-055 review)."""
    cache = tmp_path / "transcripts"
    cache.mkdir()
    file = cache / f"{_fingerprint(beep)['sha256']}.levels.json"
    stale = {
        "levelsVersion": 1,
        "mediaFingerprint": _fingerprint(beep),
        "fps": {"num": 30000, "den": 1001},
        "durationFrames": 59,
        "levels": [-20] * 59,
    }
    if damage == "fps":
        stale = {**stale, "fps": {"num": 25, "den": 1}, "durationFrames": 60, "levels": [-20] * 60}
    file.write_text(json.dumps(stale)[: 50 if damage == "truncated" else None])
    engine = Wire()
    try:
        result = _detect(engine, beep, cache, "a")["result"]
    finally:
        engine.close()
    assert result["rate"] == {"num": 30000, "den": 1001}
    assert result["durationFrames"] == len(result["levels"]) == 60
    assert result["levels"] != [-20] * 60
    data = json.loads(file.read_text())
    assert (data["fps"], data["durationFrames"], data["levels"]) == (result["rate"], 60, result["levels"])


@pytest.mark.usefixtures("tools")
def test_cancelled_silence_detect_writes_no_file(beep: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    entered, release = threading.Event(), threading.Event()
    real_decode = silence.decode_audio

    def slow_decode(path: str, job: JobContext) -> np.ndarray:
        entered.set()
        release.wait(10)
        return real_decode(path, job)

    monkeypatch.setattr(silence, "decode_audio", slow_decode)
    cache = tmp_path / "transcripts"
    cache.mkdir()
    engine = Wire()
    try:
        request = engine.request(
            "silence.detect",
            {"jobId": "slow", "path": str(beep), "cacheDir": str(cache), "fingerprint": _fingerprint(beep)},
        )
        assert entered.wait(10)
        assert engine.call("job.cancel", {"jobId": "slow"})["result"] == {"cancelled": True}
        release.set()
        assert engine.reply(request)["error"]["code"] == rpc.CANCELLED
    finally:
        engine.close()
    assert list(cache.iterdir()) == []


@pytest.mark.usefixtures("tools")
def test_silence_detect_cache_params(beep: Path, tmp_path: Path) -> None:
    engine = Wire()
    try:
        alone = engine.call("silence.detect", {"jobId": "a", "path": str(beep), "cacheDir": str(tmp_path)})
        assert alone["error"]["code"] == -32602 and "go together" in alone["error"]["message"]
        relative = engine.call(
            "silence.detect", {"jobId": "b", "path": str(beep), "cacheDir": "cache", "fingerprint": _fingerprint(beep)}
        )
        assert relative["error"]["code"] == -32602
    finally:
        engine.close()
    assert list(tmp_path.glob("*.levels.json")) == []


@pytest.mark.usefixtures("tools")
@pytest.mark.skipif(os.environ.get("S7VIDEO_MEDIA_TIMING") != "1", reason="opt-in timing: S7VIDEO_MEDIA_TIMING=1")
def test_should_handle_a_30_minute_clip(tmp_path: Path) -> None:
    """AC-5 and AC-6 on 30 minutes of tone and pauses (audio only, about 6 MB, deleted after)."""
    disk = shutil.disk_usage(tmp_path)
    assert disk.free > 15 * 2**30, "under 15 GB free; not making a long clip"
    clip = tmp_path / "long30.ogg"
    source = "aevalsrc='0.3*sin(2*PI*220*t)*lt(mod(t,3),2)+0.001*(random(0)-0.5)':s=48000:d=1800"
    assert FFMPEG is not None
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", source, "-c:a", "libopus", "-b:a", "24k", str(clip)],
        check=True,
    )
    try:
        cache = tmp_path / "transcripts"
        engine = Wire()
        try:
            started = time.perf_counter()
            fallback = _detect(engine, clip, cache, "long")["result"]
            fallback_s = time.perf_counter() - started
        finally:
            engine.close()
        assert fallback["durationFrames"] == 54_000 == len(fallback["levels"])
        written = json.loads((cache / f"{_fingerprint(clip)['sha256']}.levels.json").read_text())
        assert written["levels"] == fallback["levels"]
        # A job has no quick-call limit, but the agent tool waits 20 s for it before handing it back.
        assert fallback_s < 20, fallback_s

        info = transcribe._media_clock(str(clip), JobContext.detached())
        pcm = transcribe.decode_audio(str(clip), JobContext.detached())
        tracemalloc.start()
        try:
            before = tracemalloc.get_traced_memory()[0]
            levels = silence.frame_levels(pcm, info.clock, info.duration_frames)
            extra = tracemalloc.get_traced_memory()[1] - before
        finally:
            tracemalloc.stop()
        assert levels == fallback["levels"] == whole_clip_levels(pcm, info.clock, info.duration_frames)
        print(f"\n30-minute clip: job {fallback_s:.2f} s, levels add {extra / 1e6:.1f} MB")
        assert extra < 50 * 10**6, extra
    finally:
        clip.unlink(missing_ok=True)
