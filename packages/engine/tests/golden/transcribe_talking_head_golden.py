# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``transcribe-talking-head``: real Qwen3-ASR 1.7B + ForcedAligner on ``talking-head-01``
(S7V-026, ADR-006), with the network blocked and ``HF_HUB_OFFLINE=1``.

- Word starts against ``fixtures/media/talking-head-01.words.json``: mean error under 50 ms and at
  least 90% within one frame, on the ``pause``/``gap`` starts the harness scores. Those marks are
  machine-made (energy envelope plus captions/ASR agreement), not hand-checked by ear yet.
- At least 90% of the marked words are found, and the word sequence is within 2 points of word error rate of the
  stored reference transcript (``references/transcribe-talking-head.json``, our own model output,
  so this catches regressions rather than measuring accuracy).
- The cache file has integer frames only; a second request is answered from it in under 1 s
  without loading the model.

Needs the models: point ``S7VIDEO_TEST_MODELS_DIR`` at a folder (an ``HF_HOME``) where the engine's
download has run. It skips otherwise, so it is a developer-run golden, not a CI gate. Never point
it at the app's real data folder. Record a new reference with ``S7VIDEO_GOLDEN_UPDATE=1`` and say why
in the PR. Run with ``pnpm test:golden -- transcribe-talking-head``.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import time
from pathlib import Path
from typing import Any

import pytest

import harness
from s7engine import models
from s7engine.jobs import JobContext
from s7engine.methods import transcribe

REFERENCE = Path(__file__).parent / "references" / "transcribe-talking-head.json"
WORDS = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.words.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
SKIP_REASON = "model not downloaded; run the model download first (set S7VIDEO_TEST_MODELS_DIR)"


@pytest.fixture
def models_dir(monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = os.environ.get("S7VIDEO_TEST_MODELS_DIR", "")
    if not folder:
        pytest.skip(SKIP_REASON)
    # The engine refuses a relative HF_HOME, so a relative folder is resolved from the working folder.
    home = Path(folder).resolve()
    monkeypatch.setenv("HF_HOME", str(home))
    monkeypatch.delenv("S7_MODELS_LOCK", raising=False)
    if not models.status()["profiles"]["default"]["ready"]:
        pytest.skip(SKIP_REASON)
    return home


@pytest.fixture
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """AC-3: no network at all. Any connection attempt fails the test."""
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")

    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("transcription tried to use the network")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _fingerprint(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    size = len(data)
    mib = 1 << 20
    digest = hashlib.sha256(data if size <= 2 * mib else data[:mib] + data[-mib:])
    return {"sha256": digest.hexdigest(), "size": size}


def _word_error_rate(reference: list[str], hypothesis: list[str]) -> float:
    previous = list(range(len(hypothesis) + 1))
    for index, word in enumerate(reference, start=1):
        current = [index]
        for other_index, other in enumerate(hypothesis, start=1):
            current.append(min(previous[other_index] + 1, current[-1] + 1, previous[other_index - 1] + (word != other)))
        previous = current
    return previous[-1] / max(len(reference), 1)


def _numbers(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [number for key, item in value.items() if key != "confidence" for number in _numbers(item)] + (
            [value["confidence"]] if isinstance(value.get("confidence"), float) else []
        )
    if isinstance(value, list):
        return [number for item in value for number in _numbers(item)]
    return [value] if isinstance(value, (int, float)) and not isinstance(value, bool) else []


def _norm(words: list[dict[str, Any]]) -> list[str]:
    return [transcribe._norm(word["text"]) for word in words]


def test_transcribe_talking_head(media: Any, models_dir: Path, offline: None, tmp_path: Path) -> None:
    clip = media("talking-head-01")
    params = {"path": str(clip), "cacheDir": str(tmp_path / "transcripts"), "fingerprint": _fingerprint(clip)}
    transcribe.holder().unload()
    result = transcribe._run(params, JobContext("golden", None))
    assert result["cached"] is False and result["model"] == "mlx-community/Qwen3-ASR-1.7B-8bit"

    text = Path(result["path"]).read_text(encoding="utf-8")
    transcript = json.loads(text)
    fps = transcript["fps"]
    assert fps == {"num": 24000, "den": 1001}
    for word in transcript["words"]:
        assert set(word) == {"text", "startFrame", "endFrame", "confidence", "speaker"}
        assert isinstance(word["startFrame"], int) and isinstance(word["endFrame"], int)
        assert word["endFrame"] > word["startFrame"] and word["speaker"] == "S1"
        assert word["confidence"] is None or 0 <= word["confidence"] <= 1
    # No float seconds anywhere: the only non-integer numbers are word confidences.
    assert set(transcript) == {
        "transcriptVersion", "mediaFingerprint", "model", "revision", "fps", "durationFrames", "words", "createdAt"
    }
    floats = [value for value in _numbers(transcript) if isinstance(value, float)]
    assert len(floats) <= len(transcript["words"])

    marks = json.loads(WORDS.read_text(encoding="utf-8"))
    actual = [
        {"text": word["text"], "start": word["startFrame"], "end": word["endFrame"]} for word in transcript["words"]
    ]
    report = harness.word_timing_diff(marks["words"], actual, f"{fps['num']}/{fps['den']}", actual_unit="frames")
    print(f"\ntranscribe-talking-head: {report.summary()}; {len(transcript['words'])} words; timings {result['timings']}")
    # Recall of the marked words: 37 of 40 here. The misses are recognition, not timing: words at a
    # chunk's start ("request"), and "the encyclopedia" heard as "Wikipedia".
    assert len(report.matched) >= 0.9 * len(marks["words"]), [word["text"] for word in report.missing]
    assert report.mean_abs_start_error_ms < 50
    assert report.within_one_frame >= 0.9

    words = _norm(transcript["words"])
    if UPDATE or not REFERENCE.exists():
        if not UPDATE:
            pytest.fail(f"no reference at {REFERENCE}; record one with S7VIDEO_GOLDEN_UPDATE=1")
        REFERENCE.write_text(
            json.dumps({"clip": "talking-head-01", "model": result["model"], "words": words}, indent=1) + "\n",
            encoding="utf-8",
        )
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))["words"]
    assert _word_error_rate(reference, words) <= 0.02

    # AC-8: the same media again comes from the cache, without loading the model.
    transcribe.holder().unload()
    loads = transcribe.holder().loads
    started = time.perf_counter()
    again = transcribe._run(params, JobContext("golden-2", None))
    assert again["cached"] is True and again["path"] == result["path"]
    assert time.perf_counter() - started < 1
    assert transcribe.holder().loads == loads and transcribe.holder().loaded_profile is None
