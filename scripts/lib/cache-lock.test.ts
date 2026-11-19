// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Runs real processes against a scratch cache.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { withCacheLock } from "./cache-lock.ts";

const MODULE = NodeURL.fileURLToPath(new URL("./cache-lock.ts", import.meta.url));

// Each child says "ready", waits for the go file, takes the lock, and inside it claims `held` with
// an exclusive mkdir: a second holder at the same moment fails with EEXIST and exits non-zero.
const CHILD = `
const { withCacheLock } = await import(process.env.LOCK_MODULE);
const fs = await import("node:fs");
const wait = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\\n");
while (!fs.existsSync(process.env.GO)) Atomics.wait(wait, 0, 0, 1);
withCacheLock(process.env.CACHE, () => {
  fs.mkdirSync(process.env.CACHE + "/held");
  Atomics.wait(wait, 0, 0, 5);
  fs.rmSync(process.env.CACHE + "/held", { recursive: true });
}, { pollMs: 3, timeoutMs: 60000 });
`;

const runRound = async (cache: string, round: number, processes: number) => {
  const go = NodePath.join(cache, `go-${String(round)}`);
  const ready: Array<Promise<void>> = [];
  const exits = Array.from({ length: processes }, () => {
    const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
      env: { ...process.env, LOCK_MODULE: MODULE, CACHE: cache, GO: go },
      stdio: ["ignore", "pipe", "pipe"],
    });
    ready.push(new Promise((resolve) => child.stdout.once("data", () => resolve())));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    return new Promise<{ code: number | null; stderr: string }>((resolve) =>
      child.on("exit", (code) => resolve({ code, stderr })),
    );
  });
  // All twelve start together, once every one of them is up.
  await Promise.all(ready);
  NodeFS.writeFileSync(go, "");
  const results = await Promise.all(exits);
  NodeFS.rmSync(go);
  return results;
};

const deadPid = () => NodeChildProcess.spawnSync("/usr/bin/true").pid;

describe("withCacheLock", () => {
  it("one holder at a time, released after the body, a live holder blocks", () => {
    const cache = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cache-lock-"));
    try {
      const lockDir = NodePath.join(cache, ".lock");
      expect(withCacheLock(cache, () => NodeFS.existsSync(lockDir))).toBe(true);
      expect(NodeFS.existsSync(lockDir)).toBe(false);

      NodeFS.mkdirSync(lockDir);
      NodeFS.writeFileSync(NodePath.join(lockDir, "owner"), `${String(process.ppid)}\n`);
      expect(() => withCacheLock(cache, () => "ran", { timeoutMs: 50, pollMs: 10 })).toThrow(
        `held by PID ${String(process.ppid)}`,
      );

      // A lock whose owner never got written (a build killed mid-take) is cleared once old.
      NodeFS.rmSync(NodePath.join(lockDir, "owner"));
      expect(() => withCacheLock(cache, () => "ran", { timeoutMs: 50, pollMs: 10 })).toThrow(
        "held by PID unknown",
      );
      expect(
        withCacheLock(cache, () => "ran", { timeoutMs: 500, pollMs: 10, ownerlessMs: 0 }),
      ).toBe("ran");
    } finally {
      NodeFS.rmSync(cache, { recursive: true, force: true });
    }
  });

  it("twelve builds at once, with and without a dead build's lock: one holder, no crash", async () => {
    const cache = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cache-lock-"));
    try {
      const failures: string[] = [];
      for (const [round, stale] of [true, false, true, false, true, false].entries()) {
        if (stale) {
          NodeFS.mkdirSync(NodePath.join(cache, ".lock"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(cache, ".lock/owner"), `${String(deadPid())}\n`);
        }
        for (const result of await runRound(cache, round, 12)) {
          if (result.code !== 0) {
            failures.push(/^\w*Error.*$/mu.exec(result.stderr)?.[0] ?? result.stderr.trim());
          }
        }
      }
      expect(failures).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(cache, ".lock"))).toBe(false);
    } finally {
      NodeFS.rmSync(cache, { recursive: true, force: true });
    }
  });
});
