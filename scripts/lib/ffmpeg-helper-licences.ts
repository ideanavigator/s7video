// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The FFmpeg helper half of `pnpm licenses:check` (S7V-016): the pinned sources in
// packages/engine/ffmpeg/versions.lock against licenses.allowlist.json, where LGPL is allowed only
// for a library that ships as its own dylib beside ffmpeg and ffprobe, and a built helper's
// `ffmpeg -buildconf` must not turn on GPL, nonfree or version-3 code. Pure functions;
// scripts/licenses-check.ts reads the files and runs the helper.
import { judgeLicence, type LicenceAllowlist, type LicenceElection } from "./licenses-check.ts";

/** A licence the helper may ship that npm and Python packages may not (ADR-003). */
export interface HelperAllowance {
  readonly license: string;
  /** The sources it covers; absent means any source. */
  readonly packages?: ReadonlyArray<string>;
  /** Only for a library linked dynamically, so the user can replace it (LGPL). */
  readonly dynamicOnly?: boolean;
  readonly reason: string;
}

export type HelperAllowlist = LicenceAllowlist & {
  readonly helper?: ReadonlyArray<HelperAllowance>;
};

export interface HelperLicenceResult {
  readonly checked: number;
  readonly elections: ReadonlyArray<LicenceElection>;
  readonly problems: ReadonlyArray<string>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9A-F]{40}$/;
const LINKAGES = ["dynamic", "static"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const judge = (
  label: string,
  declared: string,
  allowlist: HelperAllowlist,
  allowances: ReadonlyArray<string>,
  scope: "production" | "development",
) =>
  judgeLicence(
    declared,
    scope,
    { ...allowlist, allowed: [...allowlist.allowed, ...allowances] },
    undefined,
    label,
  );

/** Checks every pinned source and build tool of the helper's versions.lock. */
export function checkHelperSources(lock: unknown, allowlist: HelperAllowlist): HelperLicenceResult {
  const problems: string[] = [];
  const elections: LicenceElection[] = [];
  if (!isRecord(lock) || !Array.isArray(lock.sources) || lock.sources.length === 0) {
    return { checked: 0, elections, problems: ["versions.lock has no sources list"] };
  }
  let checked = 0;
  for (const entry of lock.sources) {
    checked += 1;
    const name = isRecord(entry) ? text(entry.name) : undefined;
    if (!isRecord(entry) || name === undefined) {
      problems.push(`source ${String(checked)} has no name`);
      continue;
    }
    const version = text(entry.version) ?? "?";
    const label = `${name}@${version}`;
    const license = text(entry.license);
    const linkage = text(entry.linkage);
    const url = text(entry.url);
    if (url === undefined || !url.startsWith("https://")) {
      problems.push(`${label}: its url must be https`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      problems.push(`${label}: needs a pinned lower-case sha256`);
    }
    if (!Array.isArray(entry.licenseFiles) || entry.licenseFiles.length === 0) {
      problems.push(`${label}: names no licence file to ship`);
    }
    if (linkage === undefined || !(LINKAGES as ReadonlyArray<string>).includes(linkage)) {
      problems.push(`${label}: linkage must be "dynamic" or "static"`);
    }
    if (name === "ffmpeg") {
      const signature = isRecord(entry.signature) ? entry.signature : undefined;
      if (
        typeof signature?.fingerprint !== "string" ||
        !FINGERPRINT.test(signature.fingerprint) ||
        text(signature.url) === undefined ||
        text(signature.key) === undefined ||
        typeof signature.keySha256 !== "string" ||
        !SHA256.test(signature.keySha256)
      ) {
        problems.push(
          `${label}: needs its release signature, the key kept in the recipe with its sha256, and the key's fingerprint`,
        );
      }
    }
    if (license === undefined) {
      problems.push(`${label}: has no licence`);
      continue;
    }
    const allowances = (allowlist.helper ?? [])
      .filter((allowance) => allowance.packages === undefined || allowance.packages.includes(name))
      .filter((allowance) => allowance.dynamicOnly !== true || linkage === "dynamic")
      .map((allowance) => allowance.license);
    const verdict = judge(label, license, allowlist, allowances, "production");
    if (!verdict.ok) {
      const lgpl = /\bLGPL-/i.test(license) && linkage !== "dynamic";
      problems.push(
        lgpl
          ? `${label} ${license}: LGPL is allowed only as a dynamically linked helper library`
          : `${label} ${license}: ${verdict.reason ?? "is not on the allowlist"}`,
      );
    } else if (/\sOR\s/i.test(license) && verdict.elected !== undefined) {
      elections.push({ name, version, declared: license, elected: verdict.elected });
    }
  }
  for (const tool of Array.isArray(lock.buildTools) ? lock.buildTools : []) {
    checked += 1;
    const name = isRecord(tool) ? text(tool.name) : undefined;
    const license = isRecord(tool) ? text(tool.license) : undefined;
    const label = `${name ?? "?"}@${isRecord(tool) ? (text(tool.version) ?? "?") : "?"} (build tool)`;
    if (name === undefined || license === undefined) {
      problems.push(`${label}: needs a name and a licence`);
      continue;
    }
    const verdict = judge(name, license, allowlist, [], "development");
    if (!verdict.ok) problems.push(`${label} ${license}: ${verdict.reason ?? "not allowed"}`);
  }
  return { checked, elections, problems };
}

/**
 * versions.lock's build tools against build-tools.txt (uv's hash-pinned requirements, the file
 * the build installs from): every tool needs the same pinned version and at least one sha256.
 */
export function buildToolPinProblems(lock: unknown, requirements: string): ReadonlyArray<string> {
  const pins = new Map<string, { version: string; hashed: boolean }>();
  for (const block of requirements.split(/\n(?=[a-z0-9])/i)) {
    const match = /^([A-Za-z0-9._-]+)==(\S+)/.exec(block.trim());
    if (match?.[1] && match[2]) {
      pins.set(match[1].toLowerCase(), {
        version: match[2],
        hashed: block.includes("--hash=sha256:"),
      });
    }
  }
  const tools = isRecord(lock) && Array.isArray(lock.buildTools) ? lock.buildTools : [];
  const problems: string[] = [];
  for (const tool of tools) {
    const name = isRecord(tool) ? text(tool.name)?.toLowerCase() : undefined;
    const version = isRecord(tool) ? text(tool.version) : undefined;
    if (name === undefined || version === undefined) continue;
    const pin = pins.get(name);
    if (!pin) problems.push(`${name}@${version} (build tool) is not in build-tools.txt`);
    else if (pin.version !== version)
      problems.push(`${name}@${version} (build tool): build-tools.txt pins ${pin.version}`);
    else if (!pin.hashed)
      problems.push(`${name}@${version} (build tool): build-tools.txt has no sha256`);
  }
  for (const name of pins.keys()) {
    if (!tools.some((tool) => isRecord(tool) && text(tool.name)?.toLowerCase() === name)) {
      problems.push(
        `${name} is installed from build-tools.txt but versions.lock does not list its licence`,
      );
    }
  }
  return problems;
}

const FORBIDDEN_FLAGS = ["--enable-gpl", "--enable-nonfree", "--enable-version3"] as const;

/** `ffmpeg -buildconf` output: GPL, nonfree and version-3 code are never shipped. */
export function buildconfProblems(buildconf: string): ReadonlyArray<string> {
  const flags = new Set(buildconf.split(/\s+/).filter((token) => token.startsWith("--")));
  if (flags.size === 0) return ["ffmpeg -buildconf printed no configuration"];
  return FORBIDDEN_FLAGS.filter((flag) => flags.has(flag)).map(
    (flag) => `the built FFmpeg helper was configured with ${flag}`,
  );
}
