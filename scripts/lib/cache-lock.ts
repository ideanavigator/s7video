// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// A `mkdir` lock on a build cache that several worktrees share (S7V-112, reused by S7V-016): one
// holder at a time, and a lock left by a build that died is taken over safely.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface CacheLockOptions {
  /** Give up after this long (default one hour). */
  readonly timeoutMs?: number;
  /** How often a waiter looks again (default 2 s). */
  readonly pollMs?: number;
  /** A lock with no owner file this old came from a build killed while taking it (default 5 min). */
  readonly ownerlessMs?: number;
  /** A takeover mutex this old came from a waiter killed mid-takeover (default 60 s). */
  readonly takeoverMs?: number;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const missing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** The owner's PID; undefined while it is not written yet, or the lock is gone. */
function readOwner(file: string): number | undefined {
  try {
    const pid = Number.parseInt(NodeFS.readFileSync(file, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function ageMs(path: string): number | undefined {
  try {
    return Date.now() - NodeFS.statSync(path).mtimeMs;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/**
 * Removes a stale lock, one waiter at a time: under `<lock>.takeover`, and only if the lock still
 * has the same dead owner (or still has none). True when the lock was removed.
 */
function takeOver(
  lockDir: string,
  owner: string,
  seen: number | undefined,
  options: CacheLockOptions,
) {
  const mutex = `${lockDir}.takeover`;
  try {
    NodeFS.mkdirSync(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((ageMs(mutex) ?? 0) > (options.takeoverMs ?? 60_000))
      NodeFS.rmSync(mutex, { recursive: true, force: true });
    return false;
  }
  try {
    const now = readOwner(owner);
    const stale =
      seen === undefined
        ? now === undefined && (ageMs(lockDir) ?? 0) > (options.ownerlessMs ?? 5 * 60_000)
        : now === seen && !isAlive(seen);
    if (stale) NodeFS.rmSync(lockDir, { recursive: true, force: true });
    return stale;
  } finally {
    NodeFS.rmSync(mutex, { recursive: true, force: true });
  }
}

/** Runs `body` holding `<cacheRoot>/.lock`, a `mkdir` lock like the heavy-run slots. */
export function withCacheLock<A>(
  cacheRoot: string,
  body: () => A,
  options: CacheLockOptions = {},
): A {
  const lockDir = NodePath.join(cacheRoot, ".lock");
  const owner = NodePath.join(lockDir, "owner");
  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60 * 1000);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  NodeFS.mkdirSync(cacheRoot, { recursive: true });
  for (;;) {
    try {
      NodeFS.mkdirSync(lockDir);
      NodeFS.writeFileSync(owner, `${String(process.pid)}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readOwner(owner);
    const looksStale =
      holder === undefined
        ? (ageMs(lockDir) ?? 0) > (options.ownerlessMs ?? 5 * 60_000)
        : !isAlive(holder);
    if (looksStale && takeOver(lockDir, owner, holder, options)) continue;
    if (Date.now() > deadline) {
      throw new Error(
        `${lockDir} is held by PID ${String(holder ?? "unknown")}; another build is using the cache`,
      );
    }
    Atomics.wait(wait, 0, 0, options.pollMs ?? 2000);
  }
  try {
    return body();
  } finally {
    NodeFS.rmSync(lockDir, { recursive: true, force: true });
  }
}
