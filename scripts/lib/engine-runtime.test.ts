// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Reads the committed lock and allowlist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  checkMachOFiles,
  checkPythonJsonLicences,
  compareMacosVersions,
  isMachO,
  packagesFromRuntimeLock,
  parseOtoolLoadCommands,
  parseRuntimeLock,
  RUNTIME_LOCK_PATH,
  type MachOFile,
  type PythonJson,
} from "./engine-runtime.ts";
import { checkLicences, type LicenceAllowlist } from "./licenses-check.ts";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const readJson = (file: string): unknown =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8"));
const LOCK = parseRuntimeLock(readJson(RUNTIME_LOCK_PATH));

const otool = (commands: ReadonlyArray<string>) =>
  commands.map((body, index) => `Load command ${String(index)}\n${body}`).join("\n");
const buildVersion = (minos: string) =>
  `      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minos}\n      sdk 26.5`;
const dylib = (name: string, cmd = "LC_LOAD_DYLIB") =>
  `          cmd ${cmd}\n      cmdsize 48\n         name ${name} (offset 24)\n   time stamp 2`;
const rpath = (path: string) =>
  `          cmd LC_RPATH\n      cmdsize 32\n         path ${path} (offset 12)`;
const file = (path: string, commands: ReadonlyArray<string>): MachOFile => ({
  path,
  commands: parseOtoolLoadCommands(otool(commands)),
});

describe("engine runtime lock", () => {
  it("pins the archives with sha256 and targets macOS 14.0", () => {
    expect(LOCK.macosMinimum).toBe("14.0");
    expect(LOCK.python.version.startsWith("3.12.")).toBe(true);
    expect(LOCK.python.archive.url).toContain("install_only_stripped");
    expect(() =>
      parseRuntimeLock({
        ...LOCK,
        python: { ...LOCK.python, archive: { ...LOCK.python.archive, sha256: "abc" } },
      }),
    ).toThrow("python.archive.sha256 is not a sha256");
    expect(() => parseRuntimeLock({ ...LOCK, trim: ["../../etc"] })).toThrow("leaves the runtime");
  });

  it("every shipped component's licence is on the allowlist (ADR-003 amendment 3)", () => {
    const result = checkLicences({
      packages: packagesFromRuntimeLock(LOCK),
      allowlist: readJson("licenses.allowlist.json") as LicenceAllowlist,
      exceptions: [],
      overrides: [],
    });
    expect(result.problems).toEqual([]);
    const names = packagesFromRuntimeLock(LOCK).map((entry) => entry.name);
    expect(names).toContain("bzip2");
    expect(names).toContain("SQLite");
    expect(names).not.toContain("Tcl/Tk");
  });

  it("fails when PYTHON.json names a licence no component accounts for", () => {
    const pythonJson: PythonJson = {
      licenses: ["Python-2.0", "CNRI-Python"],
      build_info: {
        extensions: {
          _bz2: [{ licenses: ["bzip2-1.0.6"] }],
          _ssl: [{ licenses: ["Apache-2.0", "OpenSSL"] }],
          _tkinter: [{ licenses: ["TCL", "Zlib"] }],
          _gdbm: [{ licenses: ["GPL-3.0-or-later"] }],
        },
      },
    };
    // _tkinter is trimmed and _gdbm is not built in: neither ships.
    expect(checkPythonJsonLicences(pythonJson, LOCK, new Set(["_bz2", "_ssl"]))).toEqual([]);
    expect(checkPythonJsonLicences(pythonJson, LOCK, new Set(["_bz2", "_gdbm"]))).toEqual([
      "PYTHON.json names GPL-3.0-or-later for _gdbm; no component in the lock covers it",
    ]);
    expect(
      checkPythonJsonLicences({ ...pythonJson, licenses: ["PSF-3.0"] }, LOCK, new Set()),
    ).toEqual(["PYTHON.json names PSF-3.0 for CPython; no component has it"]);
  });
});

describe("Mach-O checks", () => {
  it("compares macOS versions part by part", () => {
    expect(compareMacosVersions("14.0", "14")).toBe(0);
    expect(compareMacosVersions("11.0", "14.0")).toBe(-1);
    expect(compareMacosVersions("14.4.1", "14.0")).toBe(1);
    expect(compareMacosVersions("26.2", "14.0")).toBe(1);
  });

  it("recognises thin and fat Mach-O, not Java class files", () => {
    expect(isMachO(Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1))).toBe(true);
    expect(isMachO(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2))).toBe(true);
    // A class file: the same magic, then a version number far above any arch count.
    expect(isMachO(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x41))).toBe(false);
    expect(isMachO(new TextEncoder().encode("#!/bin/sh\n"))).toBe(false);
  });

  it("reads minos, dylibs and rpaths from otool -l", () => {
    const commands = parseOtoolLoadCommands(
      otool([
        buildVersion("14.0"),
        dylib("@rpath/libmlx.dylib"),
        dylib("/System/Library/Frameworks/Metal.framework/Versions/A/Metal", "LC_LOAD_WEAK_DYLIB"),
        rpath("@loader_path/lib"),
      ]),
    );
    expect(commands).toEqual({
      minos: "14.0",
      dylibs: [
        { name: "@rpath/libmlx.dylib", weak: false },
        { name: "/System/Library/Frameworks/Metal.framework/Versions/A/Metal", weak: true },
      ],
      rpaths: ["@loader_path/lib"],
    });
    const old = parseOtoolLoadCommands(
      otool([`      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.9\n      sdk 10.9`]),
    );
    expect(old.minos).toBe("10.9");
  });

  const present = new Set([
    "python/bin/python3.12",
    "python/lib/python3.12/site-packages/mlx/lib/libmlx.dylib",
    "python/lib/python3.12/site-packages/scipy/.dylibs/libgfortran.5.dylib",
  ]);
  const check = (files: ReadonlyArray<MachOFile>) =>
    checkMachOFiles({
      files,
      macosMinimum: "14.0",
      executable: "python/bin/python3.12",
      exists: (path) => present.has(path),
      resolveInside: true,
    });

  it("accepts the runtime's own links and macOS's libraries", () => {
    expect(
      check([
        file("python/lib/python3.12/site-packages/mlx/core.cpython-312-darwin.so", [
          buildVersion("14.0"),
          dylib("@rpath/libmlx.dylib"),
          dylib("/usr/lib/libc++.1.dylib"),
          rpath("@loader_path/lib"),
        ]),
        file("python/lib/python3.12/site-packages/scipy/linalg/_flapack.so", [
          buildVersion("11.0"),
          dylib("@loader_path/../.dylibs/libgfortran.5.dylib"),
        ]),
      ]),
    ).toEqual([]);
  });

  it("fails a wheel built for a newer macOS than the minimum", () => {
    expect(
      check([
        file("python/lib/python3.12/site-packages/mlx/lib/libmlx.dylib", [buildVersion("26.2")]),
      ]),
    ).toEqual([
      "python/lib/python3.12/site-packages/mlx/lib/libmlx.dylib needs macOS 26.2, newer than the minimum 14.0",
    ]);
  });

  it("fails links to Homebrew, missing bundle files and outside search paths", () => {
    const problems = check([
      file("python/lib/python3.12/lib-dynload/_x.so", [
        buildVersion("14.0"),
        dylib("/opt/homebrew/opt/xz/lib/liblzma.5.dylib"),
        dylib("@loader_path/libmissing.dylib"),
        dylib("@rpath/libmlx.dylib"),
        rpath("/opt/homebrew/lib"),
      ]),
    ]);
    expect(problems).toEqual([
      "python/lib/python3.12/lib-dynload/_x.so links /opt/homebrew/opt/xz/lib/liblzma.5.dylib, outside the app and macOS",
      "python/lib/python3.12/lib-dynload/_x.so links @loader_path/libmissing.dylib, which is not in the bundle",
      "python/lib/python3.12/lib-dynload/_x.so searches /opt/homebrew/lib for libraries, outside the app",
      "python/lib/python3.12/lib-dynload/_x.so links @rpath/libmlx.dylib, which is not in the bundle",
    ]);
  });

  it("outside the runtime, only the link prefixes are checked", () => {
    expect(
      checkMachOFiles({
        files: [
          file("Contents/Frameworks/Electron Framework.framework/Electron Framework", [
            buildVersion("12.0"),
            dylib("@rpath/libffmpeg.dylib"),
          ]),
          file("Contents/Resources/app.asar.unpacked/pty.node", [
            buildVersion("26.0"),
            dylib("/usr/local/lib/libutil.dylib"),
          ]),
        ],
        macosMinimum: "14.0",
        exists: () => false,
        resolveInside: false,
      }),
    ).toEqual([
      "Contents/Resources/app.asar.unpacked/pty.node needs macOS 26.0, newer than the minimum 14.0",
      "Contents/Resources/app.asar.unpacked/pty.node links /usr/local/lib/libutil.dylib, outside the app and macOS",
    ]);
  });
});
