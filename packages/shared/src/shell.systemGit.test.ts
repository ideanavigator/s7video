// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Counts every child_process entry point.
/**
 * S7V-052 AC-1/AC-2: on macOS the git probe reads files only. Every `node:child_process` entry
 * point is spied, so a stub run (`/usr/bin/git`, `xcrun`) would show as a spawn.
 */
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CommandResolutionCache,
  GitUnavailableError,
  locateDeveloperGit,
  locateSystemGit,
  resolveSpawnCommand,
  SpawnExecutableResolution,
  type SystemGitFileSystem,
  XcodeGitLocation,
} from "./shell.ts";

vi.mock("node:child_process", { spy: true });

const SPAWN_ENTRY_POINTS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;
const spawnCount = () =>
  SPAWN_ENTRY_POINTS.reduce(
    (total, name) => total + vi.mocked(NodeChildProcess[name]).mock.calls.length,
    0,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(() => expect(spawnCount()).toBe(0));

/** Executable files and symlinks that exist on the fake disk. */
const fakeDisk = (input: {
  readonly executables?: ReadonlyArray<string>;
  readonly links?: Readonly<Record<string, string>>;
}): SystemGitFileSystem & { readonly reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    isExecutableFile: (filePath) => {
      reads.push(filePath);
      return input.executables?.includes(filePath) ?? false;
    },
    readLink: (filePath) => {
      reads.push(filePath);
      return input.links?.[filePath];
    },
  };
};

const CLT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git";
const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

describe("locateDeveloperGit", () => {
  it("finds git under DEVELOPER_DIR", () => {
    const disk = fakeDisk({ executables: ["/opt/dev/usr/bin/git", CLT_GIT] });
    expect(locateDeveloperGit({ DEVELOPER_DIR: "/opt/dev" }, disk)).toBe("/opt/dev/usr/bin/git");
  });

  it("follows the xcode-select link, relative or absolute", () => {
    const beta = "/Applications/Xcode-beta.app/Contents/Developer";
    const absolute = fakeDisk({
      executables: [`${beta}/usr/bin/git`, CLT_GIT],
      links: { "/var/db/xcode_select_link": beta },
    });
    expect(locateDeveloperGit({}, absolute)).toBe(`${beta}/usr/bin/git`);

    const relative = fakeDisk({
      executables: ["/var/db/tools/usr/bin/git"],
      links: { "/var/db/xcode_select_link": "tools" },
    });
    expect(locateDeveloperGit({}, relative)).toBe("/var/db/tools/usr/bin/git");
  });

  it("finds Command Line Tools, then Xcode", () => {
    expect(locateDeveloperGit({}, fakeDisk({ executables: [CLT_GIT, XCODE_GIT] }))).toBe(CLT_GIT);
    expect(locateDeveloperGit({}, fakeDisk({ executables: [XCODE_GIT] }))).toBe(XCODE_GIT);
  });

  it("says none on a Mac without the developer tools", () => {
    const disk = fakeDisk({});
    expect(locateDeveloperGit({ DEVELOPER_DIR: "/missing" }, disk)).toBeUndefined();
    // The stub and xcrun are never looked at, only the developer folders.
    expect(disk.reads.some((read) => read.startsWith("/usr/bin"))).toBe(false);
  });
});

/** macOS with `gitOnPath` first on PATH and `disk` as the developer folders. */
const onMac = <A, E>(
  effect: Effect.Effect<A, E>,
  input: { readonly gitOnPath: string | undefined; readonly disk: SystemGitFileSystem },
) =>
  effect.pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(SpawnExecutableResolution, (command) =>
      command === "git"
        ? input.gitOnPath
        : input.disk.isExecutableFile(command)
          ? command
          : undefined,
    ),
    Effect.provideService(XcodeGitLocation, (env) => locateDeveloperGit(env, input.disk)),
    Effect.provideService(CommandResolutionCache, new Map()),
  );

describe("locateSystemGit", () => {
  effectIt.effect("prefers a user git on PATH", () =>
    Effect.gen(function* () {
      const location = yield* onMac(locateSystemGit({}), {
        gitOnPath: "/opt/homebrew/bin/git",
        disk: fakeDisk({ executables: [CLT_GIT] }),
      });
      expect(location).toEqual({ available: true, path: "/opt/homebrew/bin/git", fromPath: true });
    }),
  );

  effectIt.effect("uses the developer folder behind the stub", () =>
    Effect.gen(function* () {
      const location = yield* onMac(locateSystemGit({}), {
        gitOnPath: "/usr/bin/git",
        disk: fakeDisk({ executables: [CLT_GIT] }),
      });
      expect(location).toEqual({ available: true, path: CLT_GIT, fromPath: false });
    }),
  );

  effectIt.effect("says none with only the Apple stub, or with PATH empty", () =>
    Effect.gen(function* () {
      const none = { available: false, path: null, fromPath: false };
      const disk = fakeDisk({});
      expect(yield* onMac(locateSystemGit({}), { gitOnPath: "/usr/bin/git", disk })).toEqual(none);
      expect(yield* onMac(locateSystemGit({ PATH: "" }), { gitOnPath: undefined, disk })).toEqual(
        none,
      );
    }),
  );
});

describe("resolveSpawnCommand without git", () => {
  effectIt.effect("refuses git with a plain error and spawns nothing", () =>
    Effect.gen(function* () {
      const refused = yield* onMac(Effect.flip(resolveSpawnCommand("git", ["status"])), {
        gitOnPath: "/usr/bin/git",
        disk: fakeDisk({}),
      });
      expect(refused).toBeInstanceOf(GitUnavailableError);
      expect(refused.message).toBe("Git is not installed on this Mac.");
    }),
  );

  effectIt.effect("still resolves other commands", () =>
    Effect.gen(function* () {
      const resolved = yield* onMac(resolveSpawnCommand("ffmpeg", ["-version"]), {
        gitOnPath: "/usr/bin/git",
        disk: fakeDisk({}),
      });
      expect(resolved.command).toBe("ffmpeg");
    }),
  );
});
