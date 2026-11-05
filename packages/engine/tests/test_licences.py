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


PLATFORM_LOCK = """
version = 1
requires-python = ">=3.12"

[[package]]
name = "app"
version = "0.0.0"
source = { editable = "." }
dependencies = [
    { name = "mac-only", marker = "sys_platform == 'darwin' and platform_machine == 'arm64'" },
    { name = "linux-only", marker = "sys_platform == 'linux'" },
    { name = "windows-only", marker = "sys_platform == 'win32'" },
    { name = "everywhere" },
]

[[package]]
name = "mac-only"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "linux-only"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "windows-only"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "everywhere"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
"""


def test_markers_are_judged_for_the_mac_target_not_this_machine(tmp_path: Path, monkeypatch: object) -> None:
    import packaging.markers

    lock = tmp_path / "uv.lock"
    lock.write_text(PLATFORM_LOCK)
    # Pretend the check runs on a Linux x86 CI runner: the answer must not change.
    linux = {
        **licences.TARGET,
        "sys_platform": "linux",
        "platform_system": "Linux",
        "platform_machine": "x86_64",
        "python_version": "3.11",
        "python_full_version": "3.11.9",
    }
    monkeypatch.setattr(packaging.markers, "default_environment", lambda: dict(linux))  # type: ignore[attr-defined]
    packages = {package["name"]: package for package in licences.report(lock)["packages"]}
    assert {name: package["otherPlatform"] for name, package in packages.items()} == {
        "mac-only": False,
        "linux-only": True,
        "windows-only": True,
        "everywhere": False,
    }
    assert all(package["scope"] == "production" for package in packages.values())
