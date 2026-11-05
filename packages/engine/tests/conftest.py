# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from s7engine.methods import all_methods
from s7engine.rpc import Server


def _tool(name: str) -> str | None:
    configured = os.environ.get(f"S7_{name.upper()}")
    if configured:
        return configured
    for directory in ("/opt/homebrew/bin", "/usr/local/bin"):
        candidate = Path(directory) / name
        if candidate.exists():
            return str(candidate)
    return shutil.which(name)


FFMPEG = _tool("ffmpeg")
FFPROBE = _tool("ffprobe")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="needs ffmpeg and ffprobe")


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch) -> None:
    if FFMPEG is None or FFPROBE is None:
        pytest.skip("needs ffmpeg and ffprobe")
    monkeypatch.setenv("S7_FFMPEG", FFMPEG)
    monkeypatch.setenv("S7_FFPROBE", FFPROBE)


def make_clip(path: Path, video: str, extra: list[str] | None = None) -> Path:
    """A synthetic clip from an FFmpeg lavfi source, with codecs from FFmpeg itself (no GPL encoders)."""
    assert FFMPEG is not None
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", video, *(extra or []), str(path)],
        check=True,
    )
    return path


@pytest.fixture(scope="session")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    if FFMPEG is None or FFPROBE is None:
        pytest.skip("needs ffmpeg and ffprobe")
    root = tmp_path_factory.mktemp("clips")
    return {
        # Frame n is a flat grey of luma 16 + 3n, so a decoded frame names its own number.
        "grey": make_clip(
            root / "grey.mkv",
            "color=c=black:s=64x64:r=30:d=2,format=gray,geq=lum='16+3*N'",
            ["-c:v", "ffv1", "-pix_fmt", "gray"],
        ),
        "mp4_30": make_clip(
            root / "testsrc2-30.mp4",
            "testsrc2=s=320x240:r=30:d=3",
            ["-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac", "-shortest"],
        ),
        "mp4_2997": make_clip(
            root / "testsrc2-2997.mp4",
            "testsrc2=s=320x240:r=30000/1001:d=2",
            ["-c:v", "mpeg4", "-q:v", "4"],
        ),
    }


class Wire:
    """An engine on worker threads, fed lines through a queue, with the replies collected."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._changed = threading.Condition()
        self._next_id = 0
        self.server = Server(all_methods(), self)
        self._thread = threading.Thread(target=self.server.serve, args=(self._iterate(),), daemon=True)
        self._thread.start()

    def write(self, text: str) -> None:
        with self._changed:
            self.messages.extend(json.loads(line) for line in text.splitlines() if line)
            self._changed.notify_all()

    def flush(self) -> None:
        pass

    def _iterate(self) -> Iterator[str]:
        while (line := self._lines.get()) is not None:
            yield line

    def send_line(self, line: str) -> None:
        self._lines.put(line)

    def request(self, method: str, params: dict[str, Any] | None = None) -> int:
        self._next_id += 1
        self.send_line(json.dumps({"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}}))
        return self._next_id

    def wait_for(self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 10) -> dict[str, Any]:
        with self._changed:
            found = self._changed.wait_for(lambda: next((m for m in self.messages if predicate(m)), None), timeout)
        if found is None:
            raise AssertionError("no matching message")
        return found

    def reply(self, request_id: int, timeout: float = 10) -> dict[str, Any]:
        return self.wait_for(lambda message: message.get("id") == request_id and "method" not in message, timeout)

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.reply(self.request(method, params))

    def close(self) -> None:
        self._lines.put(None)
        self._thread.join(timeout=10)


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> Iterator[Wire]:
    monkeypatch.setenv("S7_ENGINE_TEST_METHODS", "1")
    engine = Wire()
    yield engine
    engine.close()
