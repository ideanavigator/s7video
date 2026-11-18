// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The rules behind the bundled engine runtime (S7V-112): its lock, the macOS minimum and link
// checks over every Mach-O it ships, and its licence list. Pure functions; scripts/build-engine-
// runtime.ts and scripts/build-desktop-artifact.ts run otool and feed its output here.
import type { ScannedPackage } from "./licenses-check.ts";

export interface RuntimeArchive {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface RuntimeComponent {
  readonly name: string;
  readonly version?: string;
  readonly license: string;
  /** False for what CPython links from macOS itself, or what the trim removes. */
  readonly shipped: boolean;
  /** Files in python-build-standalone's `licenses/` folder that ship with the runtime. */
  readonly licenceFiles: ReadonlyArray<string>;
  /** The PYTHON.json licence ids this component accounts for. */
  readonly pythonJsonLicences: ReadonlyArray<string>;
  /** The PYTHON.json extensions it is linked into. */
  readonly extensions: ReadonlyArray<string>;
}

export interface RuntimeLock {
  readonly lockVersion: 1;
  readonly macosMinimum: string;
  readonly python: {
    readonly version: string;
    readonly distribution: string;
    readonly release: string;
    readonly triple: string;
    readonly archive: RuntimeArchive;
    readonly licenceArchive: RuntimeArchive;
  };
  readonly trim: ReadonlyArray<string>;
  readonly trimGlobs: ReadonlyArray<string>;
  readonly components: ReadonlyArray<RuntimeComponent>;
}

export const RUNTIME_LOCK_PATH = "packages/engine/runtime/runtime.lock.json";

const SHA256 = /^[0-9a-f]{64}$/u;
const MACOS_VERSION = /^\d+(\.\d+){0,2}$/u;

/** Checks the lock's shape; a malformed lock fails the build before anything is downloaded. */
export function parseRuntimeLock(value: unknown): RuntimeLock {
  const lock = value as RuntimeLock;
  const problems: string[] = [];
  if (lock?.lockVersion !== 1) problems.push("lockVersion must be 1");
  if (!MACOS_VERSION.test(lock?.macosMinimum ?? "")) problems.push("macosMinimum is not a version");
  for (const key of ["archive", "licenceArchive"] as const) {
    const archive = lock?.python?.[key];
    if (!archive?.url?.startsWith("https://")) problems.push(`python.${key}.url must be https`);
    if (!SHA256.test(archive?.sha256 ?? "")) problems.push(`python.${key}.sha256 is not a sha256`);
    if (!Number.isInteger(archive?.size)) problems.push(`python.${key}.size must be an integer`);
  }
  for (const entry of [...(lock?.trim ?? []), ...(lock?.trimGlobs ?? [])]) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      problems.push(`trim entry ${entry} leaves the runtime folder`);
    }
  }
  if (!Array.isArray(lock?.components) || lock.components.length === 0) {
    problems.push("components is empty");
  }
  if (problems.length > 0) throw new Error(`${RUNTIME_LOCK_PATH}: ${problems.join("; ")}`);
  return lock;
}

/** 14.0 < 14.4.1 < 26.2; missing parts count as 0. */
export function compareMacosVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Thin 64-bit Mach-O, or a fat (universal) one; Java class files share the fat magic. */
export function isMachO(header: Uint8Array): boolean {
  if (header.length < 8) return false;
  const le = header[0]! | (header[1]! << 8) | (header[2]! << 16) | (header[3]! << 24);
  if (le >>> 0 === 0xfeedfacf || le >>> 0 === 0xfeedface) return true;
  const be = ((header[0]! << 24) | (header[1]! << 16) | (header[2]! << 8) | header[3]!) >>> 0;
  if (be !== 0xcafebabe && be !== 0xcafebabf) return false;
  const archCount =
    ((header[4]! << 24) | (header[5]! << 16) | (header[6]! << 8) | header[7]!) >>> 0;
  return archCount > 0 && archCount < 16;
}

export interface MachOLoadCommands {
  /** LC_BUILD_VERSION minos, or LC_VERSION_MIN_MACOSX version; undefined when neither is there. */
  readonly minos: string | undefined;
  /** Every dylib it loads (LC_LOAD_DYLIB, weak, re-exported, lazy, upward). */
  readonly dylibs: ReadonlyArray<{ readonly name: string; readonly weak: boolean }>;
  readonly rpaths: ReadonlyArray<string>;
}

const DYLIB_COMMANDS = new Set([
  "LC_LOAD_DYLIB",
  "LC_LOAD_WEAK_DYLIB",
  "LC_REEXPORT_DYLIB",
  "LC_LAZY_LOAD_DYLIB",
  "LC_LOAD_UPWARD_DYLIB",
]);

/** Parses `otool -arch arm64 -l <file>`. */
export function parseOtoolLoadCommands(output: string): MachOLoadCommands {
  let minos: string | undefined;
  const dylibs: Array<{ name: string; weak: boolean }> = [];
  const rpaths: string[] = [];
  for (const block of output.split(/^Load command \d+$/mu).slice(1)) {
    const cmd = /^\s*cmd (\S+)$/mu.exec(block)?.[1];
    if (cmd === undefined) continue;
    if (cmd === "LC_BUILD_VERSION") {
      minos ??= /^\s*minos (\S+)$/mu.exec(block)?.[1];
    } else if (cmd === "LC_VERSION_MIN_MACOSX") {
      minos ??= /^\s*version (\S+)$/mu.exec(block)?.[1];
    } else if (DYLIB_COMMANDS.has(cmd)) {
      const name = /^\s*name (.+) \(offset \d+\)$/mu.exec(block)?.[1];
      if (name !== undefined) dylibs.push({ name, weak: cmd === "LC_LOAD_WEAK_DYLIB" });
    } else if (cmd === "LC_RPATH") {
      const path = /^\s*path (.+) \(offset \d+\)$/mu.exec(block)?.[1];
      if (path !== undefined) rpaths.push(path);
    }
  }
  return { minos, dylibs, rpaths };
}

/** Where macOS itself keeps the libraries an app may link: the dyld shared cache, not the disk. */
export const isSystemLibrary = (name: string) =>
  name.startsWith("/usr/lib/") || name.startsWith("/System/");

export interface MachOFile {
  /** Path relative to the checked root, with `/` separators. */
  readonly path: string;
  readonly commands: MachOLoadCommands;
}

export interface LinkCheckInput {
  readonly files: ReadonlyArray<MachOFile>;
  readonly macosMinimum: string;
  /** The executable `@executable_path` stands for, relative to the root (python's bin/python3.12). */
  readonly executable?: string;
  /** Whether a relative path exists inside the root. */
  readonly exists: (relativePath: string) => boolean;
  /** Resolve @rpath, @loader_path and @executable_path to a file inside the root (the runtime). */
  readonly resolveInside: boolean;
}

const posixDirname = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** `a/b/../c` → `a/c`; undefined when it climbs out of the root. */
function normalise(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function expand(name: string, file: string, executable: string | undefined): string | undefined {
  if (name.startsWith("@loader_path/")) {
    return normalise(`${posixDirname(file)}/${name.slice("@loader_path/".length)}`);
  }
  if (name.startsWith("@executable_path/")) {
    return executable === undefined
      ? undefined
      : normalise(`${posixDirname(executable)}/${name.slice("@executable_path/".length)}`);
  }
  return undefined;
}

/**
 * Every Mach-O must need macOS `macosMinimum` or older and link only macOS's own libraries or files
 * inside the root, never Homebrew, /usr/local or a build machine's folders. Returns the problems.
 */
export function checkMachOFiles(input: LinkCheckInput): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const file of input.files) {
    const { minos, dylibs, rpaths } = file.commands;
    if (minos !== undefined && compareMacosVersions(minos, input.macosMinimum) > 0) {
      problems.push(
        `${file.path} needs macOS ${minos}, newer than the minimum ${input.macosMinimum}`,
      );
    }
    for (const dylib of dylibs) {
      if (isSystemLibrary(dylib.name)) continue;
      if (!dylib.name.startsWith("@")) {
        problems.push(`${file.path} links ${dylib.name}, outside the app and macOS`);
        continue;
      }
      if (!input.resolveInside) continue;
      let target: string | undefined;
      if (dylib.name.startsWith("@rpath/")) {
        const rest = dylib.name.slice("@rpath/".length);
        for (const rpath of rpaths) {
          if (!rpath.startsWith("@")) {
            if (!isSystemLibrary(rpath)) {
              problems.push(`${file.path} searches ${rpath} for libraries, outside the app`);
            }
            continue;
          }
          const candidate = expand(`${rpath}/${rest}`, file.path, input.executable);
          if (candidate !== undefined && input.exists(candidate)) {
            target = candidate;
            break;
          }
        }
      } else {
        target = expand(dylib.name, file.path, input.executable);
        if (target !== undefined && !input.exists(target)) target = undefined;
      }
      if (target === undefined && !dylib.weak) {
        problems.push(`${file.path} links ${dylib.name}, which is not in the bundle`);
      }
    }
  }
  return [...new Set(problems)];
}

export interface PythonJson {
  readonly licenses?: ReadonlyArray<string> | null;
  readonly build_info: {
    readonly extensions: Readonly<
      Record<string, ReadonlyArray<{ readonly licenses?: ReadonlyArray<string> | null }>>
    >;
  };
}

/**
 * The lock's components must account for every licence python-build-standalone's PYTHON.json
 * names, for the core and for each extension the runtime keeps (`shippedExtensions`).
 */
export function checkPythonJsonLicences(
  pythonJson: PythonJson,
  lock: RuntimeLock,
  shippedExtensions: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const core = lock.components.filter((component) => component.extensions.length === 0);
  const coreIds = new Set(core.flatMap((component) => component.pythonJsonLicences));
  for (const id of pythonJson.licenses ?? []) {
    if (!coreIds.has(id)) problems.push(`PYTHON.json names ${id} for CPython; no component has it`);
  }
  for (const [extension, variants] of Object.entries(pythonJson.build_info.extensions)) {
    if (!shippedExtensions.has(extension)) continue;
    const ids = new Set(variants.flatMap((variant) => variant.licenses ?? []));
    if (ids.size === 0) continue;
    const covering = lock.components.filter((component) =>
      component.extensions.includes(extension),
    );
    const accounted = new Set(covering.flatMap((component) => component.pythonJsonLicences));
    for (const id of ids) {
      if (!accounted.has(id)) {
        problems.push(
          `PYTHON.json names ${id} for ${extension}; no component in the lock covers it`,
        );
      }
    }
  }
  return problems;
}

/** The shipped components as packages for `checkLicences`. */
export function packagesFromRuntimeLock(lock: RuntimeLock): ReadonlyArray<ScannedPackage> {
  return lock.components
    .filter((component) => component.shipped)
    .map((component) => ({
      name: component.name,
      version: component.version ?? `${lock.python.distribution}-${lock.python.release}`,
      license: component.license,
      manifestLicense: component.license,
      path: `${RUNTIME_LOCK_PATH} (bundled Python)`,
      scope: "production" as const,
    }));
}
