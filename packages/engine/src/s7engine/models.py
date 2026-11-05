# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Transcription models (ADR-006): the pinned registry, the download job and the resident pair.

Files live under `$HF_HOME/hub/models--<org>--<name>/snapshots/<revision>/`, the Hugging Face cache
layout, and are loaded from that folder by path, so loading never touches the network. Downloads
come from the pinned `resolve/<revision>` URLs with HTTP Range resume; every file is checked
against the sha256 in `models.lock.json` before it is renamed into place, and a wrong one is
deleted. A partial file (`*.part`) is kept on cancel or a dropped connection so the next download
resumes it. Errors carry fixed messages only.
"""

from __future__ import annotations

import contextlib
import errno
import gc
import hashlib
import http.client
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .jobs import Cancelled, JobContext
from .rpc import RpcError

MODELS_MISSING = 1006
DOWNLOAD_FAILED = 1007
CHECKSUM_MISMATCH = 1008
DISK_FULL = 1009

LOCK_PATH = Path(__file__).resolve().parents[2] / "models.lock.json"
DEFAULT_BASE_URL = "https://huggingface.co"
USER_AGENT = "s7video-engine/1.0 (+https://github.com/ideanavigator/s7video)"
PROFILES: dict[str, tuple[str, str]] = {
    "default": ("asr-1.7b", "aligner-0.6b"),
    "light": ("asr-0.6b", "aligner-0.6b"),
}
_CHUNK = 1 << 20
#: Room left on the disk after a download, so the Mac is never filled to the last byte.
_DISK_MARGIN = 512 << 20
_VERIFIED = ".s7video-verified.json"


@dataclass(frozen=True)
class ModelFile:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Model:
    key: str
    repo: str
    revision: str
    files: tuple[ModelFile, ...]

    @property
    def size(self) -> int:
        return sum(file.size for file in self.files)


_REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _safe_file_path(value: Any) -> bool:
    """A lock path stays inside its model folder: relative, no `..`, no empty or odd parts."""
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        return False
    if value.startswith("/") or os.path.isabs(value):
        return False
    return all(part not in ("", ".", "..") for part in value.split("/"))


def load_lock(path: Path | None = None) -> dict[str, Model]:
    # Tests point the engine at a lock of tiny files served by a local fake server.
    lock_path = path or Path(os.environ.get("S7_MODELS_LOCK") or LOCK_PATH)
    try:
        data = json.loads(lock_path.read_text(encoding="utf-8"))
        lock = {
            key: Model(
                key=key,
                repo=entry["repo"],
                revision=entry["revision"],
                files=tuple(ModelFile(file["path"], int(file["size"]), file["sha256"]) for file in entry["files"]),
            )
            for key, entry in data["models"].items()
        }
    except (OSError, ValueError, KeyError, TypeError):
        raise RpcError(DOWNLOAD_FAILED, "the speech model list is unreadable") from None
    for model in lock.values():
        valid = (
            _REPO.match(model.repo) is not None
            and ".." not in model.repo
            and _REVISION.match(model.revision) is not None
            and all(_safe_file_path(file.path) and _SHA256.match(file.sha256) and file.size >= 0 for file in model.files)
        )
        if not valid:
            raise RpcError(DOWNLOAD_FAILED, "the speech model list is invalid")
    return lock


def models_root() -> Path:
    home = os.environ.get("HF_HOME", "")
    if not home or not os.path.isabs(home):
        raise RpcError(MODELS_MISSING, "the speech model folder is not set")
    return Path(home) / "hub"


def snapshot_dir(model: Model) -> Path:
    return models_root() / f"models--{model.repo.replace('/', '--')}" / "snapshots" / model.revision


def profile_models(profile: str) -> list[Model]:
    lock = load_lock()
    return [lock[key] for key in PROFILES[profile]]


def _verified(model: Model) -> bool:
    folder = snapshot_dir(model)
    try:
        marker = json.loads((folder / _VERIFIED).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if marker.get("revision") != model.revision:
        return False
    expected = {file.path: file.sha256 for file in model.files}
    if marker.get("files") != expected:
        return False
    # Cheap re-check on every status call: each file is still there at its locked size.
    for file in model.files:
        try:
            if (folder / file.path).stat().st_size != file.size:
                return False
        except OSError:
            return False
    return True


def _downloaded_bytes(model: Model) -> int:
    folder = snapshot_dir(model)
    total = 0
    for file in model.files:
        for candidate in (folder / file.path, folder / f"{file.path}.part"):
            with contextlib.suppress(OSError):
                total += min(candidate.stat().st_size, file.size)
                break
    return total


def status() -> dict[str, Any]:
    lock = load_lock()
    models = {
        key: {
            "repo": model.repo,
            "revision": model.revision,
            "sizeBytes": model.size,
            "downloadedBytes": model.size if _verified(model) else _downloaded_bytes(model),
            "ready": _verified(model),
        }
        for key, model in lock.items()
    }
    profiles = {
        name: {
            "models": list(keys),
            "sizeBytes": sum(lock[key].size for key in keys),
            "ready": all(models[key]["ready"] for key in keys),
        }
        for name, keys in PROFILES.items()
    }
    return {"models": models, "profiles": profiles}


def require_ready(profile: str) -> list[Model]:
    models = profile_models(profile)
    if not all(_verified(model) for model in models):
        raise RpcError(
            MODELS_MISSING,
            "the speech model is not downloaded; accept the download in the Editor panel",
            {"profile": profile},
        )
    return models


# --- Download -------------------------------------------------------------------------------


def _base_url() -> str:
    return (os.environ.get("S7_MODELS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


class _SecureRedirects(urllib.request.HTTPRedirectHandler):
    """Follows redirects only to https (the Hub sends files to its CDN). A plain-http base, which
    only the tests' local server uses, may redirect within its own origin and nowhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new = urllib.parse.urlsplit(newurl)
        old = urllib.parse.urlsplit(req.full_url)
        same_origin = (new.scheme, new.netloc) == (old.scheme, old.netloc)
        if new.scheme != "https" and not same_origin:
            raise RpcError(DOWNLOAD_FAILED, "the speech model download was redirected to an insecure address")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SecureRedirects)


def _file_url(model: Model, file: ModelFile) -> str:
    return f"{_base_url()}/{model.repo}/resolve/{model.revision}/{urllib.request.quote(file.path)}"


def _hash_file(path: Path, job: JobContext) -> hashlib._Hash:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK * 8):
            job.raise_if_cancelled()
            digest.update(chunk)
    return digest


def _check_disk(folder: Path, needed: int) -> None:
    probe = folder
    while not probe.exists():
        probe = probe.parent
    if shutil.disk_usage(probe).free < needed + _DISK_MARGIN:
        raise RpcError(DISK_FULL, "there is not enough free disk space for the speech model")


class _Progress:
    def __init__(self, total: int, already: int, job: JobContext) -> None:
        self.total = max(total, 1)
        self.done = already
        self._job = job
        self._last = 0.0
        self._last_value = 0.0

    def add(self, count: int) -> None:
        self.done += count
        now = time.monotonic()
        value = self.done / self.total
        if now - self._last >= 0.25 or value - self._last_value >= 0.01:
            self._last, self._last_value = now, value
            self._job.progress(value, "downloading")


def _write(handle: Any, chunk: bytes) -> None:
    handle.write(chunk)


def _download_file(model: Model, file: ModelFile, folder: Path, progress: _Progress, job: JobContext) -> None:
    target = folder / file.path
    partial = folder / f"{file.path}.part"
    target.parent.mkdir(parents=True, exist_ok=True)
    have = partial.stat().st_size if partial.exists() else 0
    if have > file.size:
        partial.unlink()
        have = 0
    digest = _hash_file(partial, job) if have else hashlib.sha256()
    if have < file.size:
        headers = {"User-Agent": USER_AGENT, **({"Range": f"bytes={have}-"} if have else {})}
        request = urllib.request.Request(_file_url(model, file), headers=headers)
        try:
            response = _OPENER.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            if error.code == 416 and have:
                response = None  # The server says the partial file is already complete.
            else:
                raise RpcError(DOWNLOAD_FAILED, "the speech model download failed; try again") from None
        except (urllib.error.URLError, OSError):
            raise RpcError(DOWNLOAD_FAILED, "the speech model download stopped; check the connection and try again") from None
        if response is not None:
            close = response.close
            job.on_cancel(close)
            try:
                if have and response.status != 206:
                    # The server ignored Range: start this file again.
                    have = 0
                    digest = hashlib.sha256()
                    partial.unlink(missing_ok=True)
                with partial.open("ab") as handle:
                    while True:
                        job.raise_if_cancelled()
                        chunk = response.read(_CHUNK)
                        if not chunk:
                            break
                        _write(handle, chunk)
                        digest.update(chunk)
                        progress.add(len(chunk))
            except Cancelled:
                raise
            except http.client.HTTPException:
                if job.cancelled:
                    raise Cancelled() from None
                raise RpcError(DOWNLOAD_FAILED, "the speech model download stopped; check the connection and try again") from None
            except OSError as error:
                if job.cancelled:
                    raise Cancelled() from None
                if error.errno == errno.ENOSPC:
                    partial.unlink(missing_ok=True)
                    raise RpcError(DISK_FULL, "the disk filled up during the speech model download") from None
                raise RpcError(DOWNLOAD_FAILED, "the speech model download stopped; check the connection and try again") from None
            finally:
                job.remove_on_cancel(close)
                with contextlib.suppress(Exception):
                    response.close()
    size = partial.stat().st_size if partial.exists() else 0
    if size < file.size:
        # The connection ended early: keep the partial file for the next attempt to resume.
        raise RpcError(DOWNLOAD_FAILED, "the speech model download stopped; check the connection and try again")
    if size != file.size or digest.hexdigest() != file.sha256:
        partial.unlink(missing_ok=True)
        raise RpcError(CHECKSUM_MISMATCH, "a downloaded speech model file failed its checksum and was deleted")
    os.replace(partial, target)


_DOWNLOAD_LOCK = threading.Lock()


def download(profile: str, job: JobContext) -> dict[str, Any]:
    """One download at a time: a second request waits, then finds the shared files verified."""
    while not _DOWNLOAD_LOCK.acquire(timeout=0.2):
        job.raise_if_cancelled()
    try:
        return _download(profile, job)
    finally:
        _DOWNLOAD_LOCK.release()


def _download(profile: str, job: JobContext) -> dict[str, Any]:
    models = profile_models(profile)
    pending = [model for model in models if not _verified(model)]
    total = sum(model.size for model in models)
    already = sum(model.size if model not in pending else _downloaded_bytes(model) for model in models)
    if pending:
        _check_disk(models_root(), total - already)
    progress = _Progress(total, already, job)
    job.progress(progress.done / progress.total, "downloading")
    for model in pending:
        folder = snapshot_dir(model)
        folder.mkdir(parents=True, exist_ok=True)
        for file in model.files:
            target = folder / file.path
            if target.exists() and target.stat().st_size == file.size:
                if _hash_file(target, job).hexdigest() == file.sha256:
                    continue
                target.unlink()
            _download_file(model, file, folder, progress, job)
        marker = {"revision": model.revision, "files": {file.path: file.sha256 for file in model.files}}
        refs = folder.parent.parent / "refs"
        refs.mkdir(exist_ok=True)
        (refs / "main").write_text(model.revision, encoding="utf-8")
        (folder / _VERIFIED).write_text(json.dumps(marker, indent=1), encoding="utf-8")
    job.progress(1.0, "verified")
    return {"profile": profile, "ready": True, "sizeBytes": total}


# --- The resident model pair ------------------------------------------------------------------


Loader = Callable[[Model], Any]


class IdleTimer(Protocol):
    daemon: bool

    def start(self) -> None: ...

    def cancel(self) -> None: ...


#: `threading.Timer`; tests pass a timer they fire themselves.
TimerFactory = Callable[[float, Callable[[], None]], IdleTimer]


def _mlx_loader(model: Model) -> Any:
    from mlx_audio.stt.utils import load_model
    from mlx_audio.utils import get_model_name_parts

    return load_model(snapshot_dir(model), model_name_parts=get_model_name_parts(model.repo))


def _release_memory() -> None:
    gc.collect()
    with contextlib.suppress(Exception):
        import mlx.core as mx

        mx.clear_cache()


class ModelHolder:
    """Keeps one ASR and aligner pair loaded, and unloads it after `idle_seconds` without use.

    MLX inference is not safe from several threads at once, so `use()` also serialises callers.
    """

    def __init__(
        self,
        idle_seconds: float,
        loader: Loader = _mlx_loader,
        release: Callable[[], None] = _release_memory,
        timer: TimerFactory = threading.Timer,
    ) -> None:
        self.idle_seconds = idle_seconds
        self._loader = loader
        self._release = release
        self._make_timer = timer
        self._lock = threading.Lock()
        self._state = threading.Lock()
        self._profile: str | None = None
        self._pair: tuple[Any, Any] | None = None
        self._timer: IdleTimer | None = None
        self.loads = 0

    @property
    def loaded_profile(self) -> str | None:
        return self._profile

    @contextlib.contextmanager
    def use(self, profile: str, job: JobContext):
        while not self._lock.acquire(timeout=0.2):
            job.raise_if_cancelled()
        try:
            self._cancel_timer()
            if self._profile != profile or self._pair is None:
                self._unload_locked()
                models = require_ready(profile)
                job.progress(0.0, "loading model")
                self._pair = (self._loader(models[0]), self._loader(models[1]))
                self._profile = profile
                self.loads += 1
            yield self._pair
        finally:
            self._schedule_unload()
            self._lock.release()

    def unload(self) -> None:
        with self._lock:
            self._cancel_timer()
            self._unload_locked()

    def _unload_locked(self) -> None:
        if self._pair is None:
            return
        self._pair = None
        self._profile = None
        self._release()

    def _cancel_timer(self) -> None:
        with self._state:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def _schedule_unload(self) -> None:
        if self._pair is None:
            return
        with self._state:
            self._timer = self._make_timer(self.idle_seconds, self._idle_unload)
            self._timer.daemon = True
            self._timer.start()

    def _idle_unload(self) -> None:
        if self._lock.acquire(blocking=False):
            try:
                self._unload_locked()
            finally:
                self._lock.release()


def idle_seconds_from_env() -> float:
    try:
        value = float(os.environ.get("S7_TRANSCRIBE_IDLE_UNLOAD_SECONDS", "600"))
    except ValueError:
        return 600.0
    return value if value > 0 else 600.0
