// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Reads the committed allowlist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { checkLicences, type LicenceAllowlist } from "./licenses-check.ts";
import {
  packagesFromPythonReport,
  pythonLicence,
  type PythonLicenceEntry,
  type PythonLicenceReport,
} from "./python-licences.ts";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const ALLOWLIST = JSON.parse(
  NodeFS.readFileSync(NodePath.join(ROOT, "licenses.allowlist.json"), "utf8"),
) as LicenceAllowlist;
const LOCK = "packages/engine/uv.lock";

const entry = (overrides: Partial<PythonLicenceEntry> & { name: string }): PythonLicenceEntry => ({
  version: "1.0.0",
  scope: "production",
  installed: true,
  installedVersion: overrides.version ?? "1.0.0",
  licenseExpression: null,
  license: null,
  classifiers: [],
  ...overrides,
});

const FIXTURE: PythonLicenceReport = {
  lockfile: LOCK,
  packages: [
    entry({ name: "jsonschema", licenseExpression: "MIT" }),
    entry({
      name: "pluggy",
      scope: "development",
      classifiers: ["License :: OSI Approved :: MIT License"],
    }),
    entry({ name: "packaging", licenseExpression: "Apache-2.0 OR BSD-2-Clause" }),
    entry({
      name: "copyleft-video",
      classifiers: ["License :: OSI Approved :: GNU General Public License v3 (GPLv3)"],
    }),
    entry({ name: "colorama", scope: "development", installed: false }),
  ],
};

const check = (report: PythonLicenceReport) =>
  checkLicences({
    packages: packagesFromPythonReport(report, LOCK).packages,
    allowlist: ALLOWLIST,
    exceptions: [],
    overrides: [],
  });

describe("python licences", () => {
  it("should flag a GPL Python package", () => {
    const result = check(FIXTURE);
    expect(result.checked).toBe(4);
    expect(result.problems.map((problem) => [problem.name, problem.license])).toEqual([
      ["copyleft-video", "GPL-3.0-only"],
    ]);
    expect(result.problems[0]?.path).toBe("packages/engine/uv.lock (python)");
  });

  it("passes the same lockfile without the GPL package", () => {
    const clean = {
      ...FIXTURE,
      packages: FIXTURE.packages.filter((p) => p.name !== "copyleft-video"),
    };
    expect(check(clean).problems).toEqual([]);
  });

  it("reads PEP 639 expressions, then classifiers, then a short License field", () => {
    expect(pythonLicence(entry({ name: "a", licenseExpression: "MIT", license: "GPL" }))).toBe(
      "MIT",
    );
    expect(
      pythonLicence(
        entry({
          name: "b",
          classifiers: [
            "License :: OSI Approved :: MIT License",
            "License :: OSI Approved :: Apache Software License",
          ],
        }),
      ),
    ).toBe("MIT OR Apache-2.0");
    expect(pythonLicence(entry({ name: "c", license: "BSD-3-Clause" }))).toBe("BSD-3-Clause");
    expect(pythonLicence(entry({ name: "d", license: "Copyright (c) someone, all rights" }))).toBe(
      "Unknown",
    );
    expect(pythonLicence(entry({ name: "e", classifiers: ["License :: Freeware"] }))).toBe(
      "Unknown",
    );
    expect(pythonLicence(entry({ name: "f", license: "Apache 2.0 License" }))).toBe("Apache-2.0");
  });

  it("fails a package with no licence metadata and lists uninstalled ones", () => {
    const scan = packagesFromPythonReport(
      { lockfile: LOCK, packages: [entry({ name: "mystery" }), ...FIXTURE.packages.slice(4)] },
      LOCK,
    );
    expect(scan.notInstalled).toEqual([{ name: "colorama", version: "1.0.0" }]);
    const result = checkLicences({
      packages: scan.packages,
      allowlist: ALLOWLIST,
      exceptions: [],
      overrides: [],
    });
    expect(result.problems.map((problem) => problem.message)).toEqual(["has no SPDX licence"]);
  });

  it("fails a production package it cannot read, skipping only development ones", () => {
    const scan = packagesFromPythonReport(
      {
        lockfile: LOCK,
        packages: [
          entry({ name: "platform-only", installed: false }),
          entry({ name: "colorama", scope: "development", installed: false }),
          entry({ name: "windows-only", installed: false, otherPlatform: true }),
        ],
      },
      LOCK,
    );
    expect(scan.notInstalled).toEqual([
      { name: "colorama", version: "1.0.0" },
      { name: "windows-only", version: "1.0.0" },
    ]);
    expect(scan.errors).toEqual([
      "platform-only@1.0.0 is a production dependency in the lockfile but is not installed, so its licence cannot be checked; run uv sync --frozen in packages/engine",
    ]);
  });

  it("reports an environment that drifted from the lockfile", () => {
    const scan = packagesFromPythonReport(
      {
        lockfile: LOCK,
        packages: [
          entry({
            name: "attrs",
            version: "2.0.0",
            installedVersion: "1.0.0",
            licenseExpression: "MIT",
          }),
        ],
      },
      LOCK,
    );
    expect(scan.errors).toEqual([
      "attrs is locked at 2.0.0 but 1.0.0 is installed; run uv sync --frozen in packages/engine",
    ]);
  });
});
