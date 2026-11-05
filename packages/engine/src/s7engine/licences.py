# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`python -m s7engine.licences [uv.lock]`: the licence metadata of every locked distribution, as JSON.

`pnpm licenses:check` runs this and judges the result against `licenses.allowlist.json`. Each
package in the lockfile is listed with its scope (production when the engine's own dependencies
reach it, development otherwise) and what its installed metadata declares: `License-Expression`
(PEP 639), the legacy `License` field and the `License ::` classifiers. A locked package that is
not installed (excluded by a platform marker) is listed with `installed: false`.
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


def _names(entries: Any) -> list[str]:
    return [_normalise(entry["name"]) for entry in entries or [] if isinstance(entry, dict) and "name" in entry]


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
    root_names = {_normalise(package["name"]) for package in roots}
    production = _reachable([name for root in roots for name in _names(root.get("dependencies"))], graph)
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
