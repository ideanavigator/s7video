# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

from pathlib import Path

from s7engine import licences

FIXTURE_LOCK = """
version = 1
requires-python = ">=3.12"

[[package]]
name = "app"
version = "0.0.0"
source = { editable = "." }
dependencies = [{ name = "Some_Lib" }]

[package.dev-dependencies]
dev = [{ name = "tool" }]

[[package]]
name = "some-lib"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "deep" }]

[[package]]
name = "deep"
version = "2.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "tool"
version = "3.0.0"
source = { registry = "https://pypi.org/simple" }
"""


def test_scopes_follow_the_lockfile_graph(tmp_path: Path) -> None:
    lock = tmp_path / "uv.lock"
    lock.write_text(FIXTURE_LOCK)
    packages = {package["name"]: package for package in licences.report(lock)["packages"]}
    assert set(packages) == {"some-lib", "deep", "tool"}
    assert packages["some-lib"]["scope"] == "production"
    assert packages["deep"]["scope"] == "production"
    assert packages["tool"]["scope"] == "development"
    assert packages["deep"]["installed"] is False


def test_real_lockfile_reports_installed_licences() -> None:
    packages = {package["name"]: package for package in licences.report(licences.DEFAULT_LOCK)["packages"]}
    assert "s7engine" not in packages
    assert packages["jsonschema"]["scope"] == "production"
    assert packages["jsonschema"]["licenseExpression"] == "MIT"
    assert packages["pytest"]["scope"] == "development"
    assert packages["pluggy"]["classifiers"] == ["License :: OSI Approved :: MIT License"]
