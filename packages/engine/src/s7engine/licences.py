# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`python -m s7engine.licences [uv.lock]`: the licence metadata of every locked distribution, as JSON.

`pnpm licenses:check` runs this and judges the result against `licenses.allowlist.json`. Each
package in the lockfile is listed with its scope (production when the engine's own dependencies
reach it, development otherwise) and what its installed metadata declares: `License-Expression`
(PEP 639), the legacy `License` field and the `License ::` classifiers. A locked package that is
not installed (excluded by a platform marker) is listed with `installed: false`; `otherPlatform`
says the engine reaches it only through markers that do not hold on the shipped target, Apple
Silicon macOS with CPython 3.12 (`TARGET`), such as Windows-only colorama, so it never ships.
Markers are judged against that target, never the machine running the check, so a Linux CI runner
still treats darwin-only packages such as mlx as shipped.
"""

from __future__ import annotations

import json
import sys
import tomllib
from importlib import metadata
from pathlib import Path
from typing import Any

DEFAULT_LOCK = Path(__file__).resolve().parents[2] / "uv.lock"


def _normalise(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


#: The one platform the engine ships for. Every marker variable is set, so none falls back to the
#: values of the machine running the check.
TARGET: dict[str, str] = {
    "implementation_name": "cpython",
    "implementation_version": "3.12.0",
    "os_name": "posix",
    "platform_machine": "arm64",
    "platform_python_implementation": "CPython",
    "platform_release": "25.0.0",
    "platform_system": "Darwin",
    "platform_version": "Darwin Kernel Version 25.0.0",
    "python_full_version": "3.12.0",
    "python_version": "3.12",
    "sys_platform": "darwin",
    "extra": "",
}


def _names(entries: Any, *, on_target: bool = False) -> list[str]:
    return [
        _normalise(entry["name"])
        for entry in entries or []
        if isinstance(entry, dict) and "name" in entry and (not on_target or _applies(entry.get("marker")))
    ]


def _applies(marker: Any) -> bool:
    """Whether a lockfile dependency marker holds on `TARGET`; unreadable markers count as holding."""
    if not isinstance(marker, str) or not marker:
        return True
    try:
        from packaging.markers import Marker

        return bool(Marker(marker).evaluate(dict(TARGET)))
    except Exception:
        return True


def _reachable(start: list[str], graph: dict[str, list[str]]) -> set[str]:
    seen: set[str] = set()
    stack = list(start)
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        stack.extend(graph.get(name, []))
    return seen


def _metadata(name: str) -> dict[str, Any]:
    try:
        distribution = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        return {"installed": False}
    fields = distribution.metadata
    license_text = fields.get("License") or None
    return {
        "installed": True,
        "installedVersion": distribution.version,
        "licenseExpression": fields.get("License-Expression") or None,
        # Some packages put the whole licence text here; only a short value can be an SPDX id.
        "license": license_text if license_text is not None and len(license_text) <= 200 else None,
        "classifiers": [value for value in fields.get_all("Classifier") or [] if value.startswith("License ::")],
    }


def report(lock_path: Path) -> dict[str, Any]:
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    packages = lock.get("package", [])
    roots = [
        package
        for package in packages
        if "editable" in package.get("source", {}) or "virtual" in package.get("source", {})
    ]
    graph = {_normalise(package["name"]): _names(package.get("dependencies")) for package in packages}
    local_graph = {
        _normalise(package["name"]): _names(package.get("dependencies"), on_target=True) for package in packages
    }
    root_names = {_normalise(package["name"]) for package in roots}
    production = _reachable([name for root in roots for name in _names(root.get("dependencies"))], graph)
    production_here = _reachable(
        [name for root in roots for name in _names(root.get("dependencies"), on_target=True)], local_graph
    )
    listed = []
    for package in packages:
        name = _normalise(package["name"])
        if name in root_names:
            continue
        listed.append(
            {
                "name": name,
                "version": str(package.get("version", "")),
                "scope": "production" if name in production else "development",
                "otherPlatform": name in production and name not in production_here,
                **_metadata(name),
            }
        )
    return {"lockfile": str(lock_path), "packages": listed}


def main(argv: list[str]) -> int:
    lock_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_LOCK
    json.dump(report(lock_path), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
