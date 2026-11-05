# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Job state: cancellation, progress and the partial outputs to delete when a job does not finish."""

from __future__ import annotations

import contextlib
import os
import threading
from collections.abc import Callable

ProgressSender = Callable[[float, "str | None"], None]


class Cancelled(Exception):
    pass


class JobContext:
    def __init__(self, job_id: str, send_progress: ProgressSender | None) -> None:
        self.job_id = job_id
        self._send_progress = send_progress
        self._cancelled = threading.Event()
        self._outputs: list[str] = []
        self._cleanups: list[Callable[[], None]] = []
        self._lock = threading.Lock()

    @classmethod
    def detached(cls) -> JobContext:
        """For plain requests: nothing can cancel them and progress goes nowhere."""
        return cls("", None)

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def wait_cancelled(self, timeout: float) -> bool:
        return self._cancelled.wait(timeout)

    def raise_if_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise Cancelled()

    def progress(self, value: float, stage: str | None = None) -> None:
        self.raise_if_cancelled()
        if self._send_progress is not None:
            self._send_progress(min(1.0, max(0.0, float(value))), stage)

    def track_output(self, path: str) -> None:
        """A file this job is writing; it is deleted if the job is cancelled or fails."""
        with self._lock:
            self._outputs.append(path)

    def keep_output(self, path: str) -> None:
        with self._lock:
            if path in self._outputs:
                self._outputs.remove(path)

    def on_cancel(self, cleanup: Callable[[], None]) -> None:
        """Runs `cleanup` when the job is cancelled (at once if it already was), e.g. to stop a tool."""
        with self._lock:
            self._cleanups.append(cleanup)
            run_now = self._cancelled.is_set()
        if run_now:
            cleanup()

    def remove_on_cancel(self, cleanup: Callable[[], None]) -> None:
        with self._lock, contextlib.suppress(ValueError):
            self._cleanups.remove(cleanup)

    def cancel(self) -> None:
        with self._lock:
            self._cancelled.set()
            cleanups = list(self._cleanups)
        for cleanup in cleanups:
            with contextlib.suppress(Exception):
                cleanup()

    def discard_outputs(self) -> None:
        with self._lock:
            outputs, self._outputs = self._outputs, []
        for path in outputs:
            with contextlib.suppress(FileNotFoundError):
                os.remove(path)


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, JobContext] = {}
        self._lock = threading.Lock()

    def start(self, job_id: str, send_progress: ProgressSender) -> JobContext | None:
        with self._lock:
            if job_id in self._jobs:
                return None
            context = JobContext(job_id, send_progress)
            self._jobs[job_id] = context
            return context

    def finish(self, job_id: str) -> None:
        with self._lock:
            self._jobs.pop(job_id, None)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            context = self._jobs.get(job_id)
        if context is None:
            return False
        context.cancel()
        return True

    def cancel_all(self) -> None:
        with self._lock:
            contexts = list(self._jobs.values())
        for context in contexts:
            context.cancel()
