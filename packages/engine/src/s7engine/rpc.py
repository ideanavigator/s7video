# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Newline-delimited JSON-RPC 2.0 over stdio.

One JSON object per line in each direction. Requests run on worker threads so a long job never
blocks the pipe, and `job.cancel` is answered on the reader thread at once. Bad input gets an
error response and the engine stays up. stdout carries protocol lines only; logs go to stderr and
name methods and timings, never parameters, paths or media.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import IO, Any

from .jobs import Cancelled, JobContext, JobRegistry

PROTOCOL_VERSION = 1

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
# Engine error codes. Messages are fixed text: they reach agents and logs, so no paths or output.
FILE_NOT_FOUND = 1001
MEDIA_ERROR = 1002
CANCELLED = 1003
MISSING_TOOL = 1004
OUTPUT_ERROR = 1005

log = logging.getLogger("s7engine")


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


Handler = Callable[[dict[str, Any], JobContext], Any]


@dataclass(frozen=True)
class Method:
    name: str
    handler: Handler
    params_schema: dict[str, Any]
    #: Jobs take a caller-chosen `jobId`, may stream `progress` and accept `job.cancel`.
    job: bool = False


@dataclass
class _Validators:
    compiled: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def warm() -> None:
        import jsonschema  # noqa: F401

    def validate(self, method: Method, params: dict[str, Any]) -> None:
        validator = self.compiled.get(method.name)
        if validator is None:
            # Imported after `ready` (see `warm`), not before, to keep engine start under 100 ms.
            from jsonschema import Draft202012Validator

            validator = Draft202012Validator(method.params_schema)
            self.compiled[method.name] = validator
        error = next(iter(validator.iter_errors(params)), None)
        if error is not None:
            where = "/".join(str(part) for part in error.absolute_path) or "params"
            raise RpcError(INVALID_PARAMS, f"invalid params at {where}: {error.validator} check failed")


class Server:
    def __init__(self, methods: Iterable[Method], output: IO[str], max_workers: int = 8) -> None:
        self._methods = {method.name: method for method in methods}
        self._output = output
        self._write_lock = threading.Lock()
        self._jobs = JobRegistry()
        self._validators = _Validators()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="s7engine")

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        with self._write_lock:
            self._output.write(line + "\n")
            self._output.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def serve(self, lines: Iterable[str]) -> None:
        self.notify("ready", {"version": _engine_version(), "protocol": PROTOCOL_VERSION})
        threading.Thread(target=self._validators.warm, name="s7engine-warm", daemon=True).start()
        try:
            for line in lines:
                if line.strip():
                    self.handle_line(line)
        finally:
            # stdin closed: the server is going away. Stop jobs so their tools exit too.
            self._jobs.cancel_all()
            self._pool.shutdown(wait=True, cancel_futures=True)

    def handle_line(self, line: str) -> None:
        try:
            message = json.loads(line)
        except ValueError:
            self._error(None, RpcError(PARSE_ERROR, "parse error"))
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self._error(None, RpcError(INVALID_REQUEST, "invalid request"))
            return
        request_id = message.get("id")
        if not _valid_id(request_id):
            self._error(None, RpcError(INVALID_REQUEST, "invalid request id"))
            return
        method_name = message.get("method")
        params = message.get("params", {})
        if not isinstance(method_name, str) or not isinstance(params, dict):
            self._error(request_id, RpcError(INVALID_REQUEST, "invalid request"))
            return
        if request_id is None:
            return  # Notifications from the server carry nothing the engine acts on.
        if method_name == "job.cancel":
            self._cancel(request_id, params)
            return
        method = self._methods.get(method_name)
        if method is None:
            self._error(request_id, RpcError(METHOD_NOT_FOUND, "method not found"))
            return
        context = None
        if method.job:
            job_id = params.get("jobId")
            if not isinstance(job_id, str) or not job_id:
                self._error(request_id, RpcError(INVALID_PARAMS, "invalid params at jobId: required"))
                return
            context = self._jobs.start(job_id, self._progress_sender(job_id))
            if context is None:
                self._error(request_id, RpcError(INVALID_PARAMS, "invalid params at jobId: already running"))
                return
        self._pool.submit(self._run, request_id, method, params, context)

    def _progress_sender(self, job_id: str) -> Callable[[float, str | None], None]:
        def send(progress: float, stage: str | None) -> None:
            self.notify("progress", {"jobId": job_id, "progress": progress, "stage": stage})

        return send

    def _run(self, request_id: Any, method: Method, params: dict[str, Any], context: JobContext | None) -> None:
        started = time.perf_counter()
        job = context if context is not None else JobContext.detached()
        outcome = "ok"
        try:
            self._validators.validate(method, params)
            result = method.handler(params, job)
            job.raise_if_cancelled()
            self.send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Cancelled:
            outcome = "cancelled"
            job.discard_outputs()
            self._error(request_id, RpcError(CANCELLED, "cancelled"))
        except RpcError as error:
            outcome = f"error {error.code}"
            job.discard_outputs()
            self._error(request_id, error)
        except Exception:
            outcome = "internal error"
            job.discard_outputs()
            log.exception("%s failed", method.name)
            self._error(request_id, RpcError(INTERNAL_ERROR, "internal error"))
        finally:
            if context is not None:
                self._jobs.finish(context.job_id)
            log.info("%s %s in %.1f ms", method.name, outcome, (time.perf_counter() - started) * 1000)

    def _cancel(self, request_id: Any, params: dict[str, Any]) -> None:
        job_id = params.get("jobId")
        if not isinstance(job_id, str):
            self._error(request_id, RpcError(INVALID_PARAMS, "invalid params at jobId: required"))
            return
        self.send({"jsonrpc": "2.0", "id": request_id, "result": {"cancelled": self._jobs.cancel(job_id)}})

    def _error(self, request_id: Any, error: RpcError) -> None:
        body: dict[str, Any] = {"code": error.code, "message": error.message}
        if error.data is not None:
            body["data"] = error.data
        self.send({"jsonrpc": "2.0", "id": request_id, "error": body})


def _engine_version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("s7engine")
    except PackageNotFoundError:
        return "0.0.0"


def _valid_id(value: Any) -> bool:
    return value is None or isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool))


def run(methods: Iterable[Method]) -> None:
    protocol_out = sys.stdout
    # Anything a library prints must not corrupt the protocol stream.
    sys.stdout = sys.stderr
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Server(methods, protocol_out).serve(sys.stdin)
