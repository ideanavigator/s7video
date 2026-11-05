# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import os
import time
from pathlib import Path

from conftest import Wire

from s7engine import rpc


def test_ready_first(wire: Wire) -> None:
    ready = wire.wait_for(lambda message: message.get("method") == "ready")
    assert ready["params"]["protocol"] == rpc.PROTOCOL_VERSION
    assert wire.messages[0] is ready


def test_rpc_roundtrip(wire: Wire) -> None:
    wire.send_line('{"jsonrpc":"2.0","id":"a-1","method":"engine.ping"}')
    first = wire.request("engine.ping")
    reply = wire.reply(first)
    assert reply["result"]["pong"] is True
    assert reply["result"]["pid"] == os.getpid()
    named = wire.wait_for(lambda message: message.get("id") == "a-1")
    assert named["result"]["pong"] is True


def test_reject_malformed_request_and_stay_up(wire: Wire) -> None:
    wire.send_line("not json at all")
    wire.send_line('{"jsonrpc":"1.0","id":5,"method":"engine.ping"}')
    wire.send_line('{"jsonrpc":"2.0","id":true,"method":"engine.ping"}')
    wire.send_line('{"jsonrpc":"2.0","id":6,"method":"engine.ping","params":[1]}')
    codes = [
        wire.wait_for(lambda message: message.get("error", {}).get("code") == rpc.PARSE_ERROR),
        wire.wait_for(lambda message: message.get("error", {}).get("code") == rpc.INVALID_REQUEST),
    ]
    assert all(message["id"] is None for message in codes)
    assert wire.reply(6)["error"]["code"] == rpc.INVALID_REQUEST
    assert wire.call("engine.ping")["result"]["pong"] is True


def test_unknown_method_and_bad_params(wire: Wire) -> None:
    assert wire.call("media.nothing")["error"]["code"] == rpc.METHOD_NOT_FOUND
    bad = wire.call("media.probe", {"path": 3})
    assert bad["error"] == {"code": rpc.INVALID_PARAMS, "message": "invalid params at path: type check failed"}
    extra = wire.call("engine.ping", {"surprise": 1})
    assert extra["error"]["code"] == rpc.INVALID_PARAMS


def test_cancel_long_job_within_one_second(wire: Wire, tmp_path: Path) -> None:
    output = tmp_path / "partial.bin"
    request = wire.request("test.slowJob", {"jobId": "job-1", "outputPath": str(output), "steps": 1000, "stepMs": 50})
    progress = wire.wait_for(lambda message: message.get("method") == "progress")
    assert progress["params"]["jobId"] == "job-1"
    assert 0 < progress["params"]["progress"] <= 1
    assert output.exists()
    cancelled_at = time.monotonic()
    assert wire.call("job.cancel", {"jobId": "job-1"})["result"] == {"cancelled": True}
    reply = wire.reply(request)
    assert time.monotonic() - cancelled_at < 1
    assert reply["error"]["code"] == rpc.CANCELLED
    assert not output.exists()
    assert wire.call("job.cancel", {"jobId": "job-1"})["result"] == {"cancelled": False}


def test_job_needs_a_unique_job_id(wire: Wire, tmp_path: Path) -> None:
    assert wire.call("test.slowJob", {"outputPath": str(tmp_path / "x")})["error"]["code"] == rpc.INVALID_PARAMS
    wire.request("test.slowJob", {"jobId": "same", "outputPath": str(tmp_path / "a"), "steps": 100})
    wire.wait_for(lambda message: message.get("method") == "progress")
    duplicate = wire.call("test.slowJob", {"jobId": "same", "outputPath": str(tmp_path / "b")})
    assert duplicate["error"]["code"] == rpc.INVALID_PARAMS
    wire.call("job.cancel", {"jobId": "same"})


def test_finished_job_keeps_its_output(wire: Wire, tmp_path: Path) -> None:
    output = tmp_path / "done.bin"
    reply = wire.call("test.slowJob", {"jobId": "j", "outputPath": str(output), "steps": 2, "stepMs": 1})
    assert reply["result"]["steps"] == 2
    assert output.stat().st_size == 2048
