// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The Python half of `pnpm licenses:check`: turns `python -m s7engine.licences` output (each
// distribution locked in packages/engine/uv.lock, with its installed metadata) into packages the
// npm rules in licenses-check.ts judge. Pure functions; scripts/licenses-check.ts runs the engine.
import type { DependencyScope, ScannedPackage } from "./licenses-check.ts";

export interface PythonLicenceEntry {
  readonly name: string;
  readonly version: string;
  readonly scope: DependencyScope;
  readonly installed: boolean;
  readonly installedVersion?: string | undefined;
  readonly licenseExpression?: string | null | undefined;
  readonly license?: string | null | undefined;
  readonly classifiers?: ReadonlyArray<string> | undefined;
}

export interface PythonLicenceReport {
  readonly lockfile: string;
  readonly packages: ReadonlyArray<PythonLicenceEntry>;
}

/** `License ::` trove classifiers to SPDX ids. An unlisted classifier leaves the licence unknown. */
const CLASSIFIER_SPDX: Readonly<Record<string, string>> = {
  "License :: OSI Approved :: MIT License": "MIT",
  "License :: OSI Approved :: MIT No Attribution License (MIT-0)": "MIT-0",
  "License :: OSI Approved :: Apache Software License": "Apache-2.0",
  // The classifier names no clause count; both BSD variants are on the allowlist.
  "License :: OSI Approved :: BSD License": "BSD-3-Clause",
  "License :: OSI Approved :: ISC License (ISCL)": "ISC",
  "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
  "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
  "License :: OSI Approved :: The Unlicense (Unlicense)": "Unlicense",
  "License :: OSI Approved :: zlib/libpng License": "Zlib",
  "License :: OSI Approved :: GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
  "License :: OSI Approved :: GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
  "License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
  "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
  "License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
  "License :: OSI Approved :: GNU Affero General Public License v3": "AGPL-3.0-only",
};

const SPDX_LIKE = /^[A-Za-z0-9.+-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/;

/** The licence a distribution declares: PEP 639 expression, then classifiers, then a short `License`. */
export function pythonLicence(entry: PythonLicenceEntry): string {
  if (entry.licenseExpression) return entry.licenseExpression;
  const fromClassifiers = (entry.classifiers ?? []).map(
    (classifier) => CLASSIFIER_SPDX[classifier],
  );
  if (fromClassifiers.length > 0) {
    return fromClassifiers.every((id) => id !== undefined)
      ? [...new Set(fromClassifiers)].join(" OR ")
      : "Unknown";
  }
  const legacy = entry.license?.trim();
  return legacy && SPDX_LIKE.test(legacy) ? legacy : "Unknown";
}

export interface PythonScan {
  readonly packages: ReadonlyArray<ScannedPackage>;
  /**
   * Development packages locked but not installed here (a platform marker, such as Windows-only
   * colorama). Production packages must be installed so their licence can be read; one that is
   * not is an error, since it could ship.
   */
  readonly notInstalled: ReadonlyArray<{ readonly name: string; readonly version: string }>;
  /** Uninstalled production packages, and versions that drifted from the lockfile. */
  readonly errors: ReadonlyArray<string>;
}

export function packagesFromPythonReport(
  report: PythonLicenceReport,
  lockPath: string,
): PythonScan {
  const packages: ScannedPackage[] = [];
  const notInstalled: Array<{ name: string; version: string }> = [];
  const errors: string[] = [];
  for (const entry of report.packages) {
    if (!entry.installed) {
      if (entry.scope === "production") {
        errors.push(
          `${entry.name}@${entry.version} is a production dependency in the lockfile but is not installed, so its licence cannot be checked; run uv sync --frozen in packages/engine`,
        );
      } else {
        notInstalled.push({ name: entry.name, version: entry.version });
      }
      continue;
    }
    if (entry.installedVersion !== undefined && entry.installedVersion !== entry.version) {
      errors.push(
        `${entry.name} is locked at ${entry.version} but ${entry.installedVersion} is installed; run uv sync --frozen in packages/engine`,
      );
    }
    const license = pythonLicence(entry);
    packages.push({
      name: entry.name,
      version: entry.version,
      license,
      manifestLicense: license === "Unknown" ? undefined : license,
      path: `${lockPath} (python)`,
      scope: entry.scope,
    });
  }
  return { packages, notInstalled, errors };
}
