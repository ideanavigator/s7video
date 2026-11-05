#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain repository scan; no Effect runtime.
// `pnpm licenses:check`: every installed npm package against licenses.allowlist.json. See
// docs/internals/open-source-licenses.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { checkNoMedia } from "./check-no-media.ts";
import {
  checkLicences,
  packagesFromPnpm,
  type LicenceAllowlist,
  type LicenceException,
  type LicenceOverride,
} from "./lib/licenses-check.ts";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function readJson(file: string): unknown {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8"));
}

function pnpmLicences(production: boolean): unknown {
  const args = ["licenses", "list", "--json", "--recursive", ...(production ? ["--prod"] : [])];
  return JSON.parse(
    NodeChildProcess.execFileSync("pnpm", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
}

function readManifestFields(packagePath: string): {
  repositoryUrl: string | undefined;
  manifestLicense: string | undefined;
} {
  try {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.resolve(ROOT, packagePath, "package.json"), "utf8"),
    ) as { repository?: string | { url?: string }; license?: unknown };
    return {
      repositoryUrl:
        typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url,
      manifestLicense:
        typeof manifest.license === "string" && manifest.license.trim().length > 0
          ? manifest.license.trim()
          : undefined,
    };
  } catch {
    return { repositoryUrl: undefined, manifestLicense: undefined };
  }
}

/** Licences that third-party-licenses.config.json's packageOverrides state for broken metadata. */
function readOverrides(): LicenceOverride[] {
  const config = readJson("third-party-licenses.config.json") as {
    packageOverrides?: ReadonlyArray<{
      name?: string;
      version?: string;
      repositoryUrl?: string;
      license?: string;
      generatedNotice?: { licenseId: string };
      generatedNotices?: ReadonlyArray<{ licenseId: string }>;
    }>;
  };
  return (config.packageOverrides ?? []).flatMap((override) => {
    const notices =
      override.generatedNotices ?? (override.generatedNotice ? [override.generatedNotice] : []);
    const license =
      override.license ??
      (notices.length > 0 ? notices.map((notice) => notice.licenseId).join(" AND ") : undefined);
    return license
      ? [
          {
            license,
            name: override.name,
            version: override.version,
            repositoryUrl: override.repositoryUrl,
          },
        ]
      : [];
  });
}

/** Keys of pnpm-workspace.yaml's patchedDependencies (`name`, `name@version` or `name@range`). */
function readPatchedPackages(): Set<string> {
  const workspace = NodeFS.readFileSync(NodePath.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const section = /^patchedDependencies:\n((?:[ \t]+.*\n?)*)/m.exec(workspace)?.[1] ?? "";
  return new Set([...section.matchAll(/^\s+["']?(.+?)["']?:\s/gm)].map((match) => match[1] ?? ""));
}

const packages = packagesFromPnpm({
  all: pnpmLicences(false),
  production: pnpmLicences(true),
  root: ROOT,
}).map((scanned) => ({ ...scanned, ...readManifestFields(scanned.path) }));

const allowlist = readJson("licenses.allowlist.json") as LicenceAllowlist;
const { exceptions } = readJson("licenses.exceptions.json") as {
  exceptions: ReadonlyArray<LicenceException>;
};
const result = checkLicences({
  packages,
  allowlist,
  exceptions,
  overrides: readOverrides(),
  patched: readPatchedPackages(),
});

const production = packages.filter((scanned) => scanned.scope === "production").length;
console.log(
  `licenses:check: ${String(result.checked)} installed packages (${String(production)} production, ${String(result.checked - production)} development only).`,
);
for (const election of result.elections) {
  console.log(
    `  elected ${election.elected} for ${election.name}@${election.version} (${election.declared})`,
  );
}
for (const exception of result.exceptions) {
  console.log(
    `  exception ${exception.adr}: ${exception.name}@${exception.version} (${exception.path})`,
  );
}
for (const error of result.configErrors) console.error(`error: ${error}`);
for (const problem of result.problems) {
  console.error(
    `error: ${problem.name}@${problem.version} [${problem.scope}] ${problem.license}: ${problem.message}\n       at ${problem.path}`,
  );
}

// S7V-031: no audio, video or model weights may be tracked.
const mediaExit = checkNoMedia(ROOT);

if (result.problems.length > 0 || result.configErrors.length > 0) {
  console.error(
    `licenses:check failed: ${String(result.problems.length)} package(s) outside the allowlist, ${String(result.configErrors.length)} exception error(s). Replace the package, or record an ADR and add it to licenses.exceptions.json.`,
  );
  process.exit(1);
}
if (mediaExit !== 0) process.exit(mediaExit);
console.log("licenses:check passed.");
