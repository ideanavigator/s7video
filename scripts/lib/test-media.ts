// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - A dev download script; no Effect runtime.
// Test media (S7V-031): free-licence clips listed in fixtures/media/manifest.json, downloaded once
// into a cache outside the repo and checked against their sha256 and size.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

export interface TestClip {
  readonly id: string;
  /** File name inside the cache. */
  readonly file: string;
  readonly url: string;
  /** Other URLs serving the same bytes, tried in order when `url` fails. */
  readonly mirrors?: ReadonlyArray<string>;
  readonly sha256: string;
  readonly size: number;
  readonly licence: string;
  readonly sourcePage: string;
}

export interface TestMediaManifest {
  readonly clips: ReadonlyArray<TestClip>;
}

export const USER_AGENT = "s7video-test-media/1.0 (+https://github.com/ideanavigator/s7video)";

/** `$S7VIDEO_TEST_MEDIA_DIR`, or `~/Library/Caches/s7video-test-media`. Never inside the repo. */
export function testMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.S7VIDEO_TEST_MEDIA_DIR;
  if (override) return NodePath.resolve(override);
  return NodePath.join(NodeOS.homedir(), "Library", "Caches", "s7video-test-media");
}

export function readManifest(file: string): TestMediaManifest {
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as TestMediaManifest;
}

export class TestMediaError extends Error {}

function sha256OfFile(file: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    let read: number;
    while ((read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
}

/** `undefined` when `file` has the clip's size and sha256, otherwise what is wrong with it. */
export function verifyClipFile(clip: TestClip, file: string): string | undefined {
  const size = NodeFS.statSync(file).size;
  if (size !== clip.size) {
    return `${clip.id}: size mismatch: expected ${clip.size} bytes, got ${size} (truncated or wrong file)`;
  }
  const actual = sha256OfFile(file);
  if (actual !== clip.sha256) {
    return `${clip.id}: sha256 mismatch: expected ${clip.sha256}, got ${actual}`;
  }
  return undefined;
}

function describeWriteError(error: unknown, file: string): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return `disk full while writing ${file}; free some space or point S7VIDEO_TEST_MEDIA_DIR at another disk`;
  }
  if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
    return `cannot write ${file} (${code}); set S7VIDEO_TEST_MEDIA_DIR to a writable folder`;
  }
  return undefined;
}

export interface FetchOptions {
  readonly dir: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Opens the partial download for writing; tests swap it to simulate a full disk. */
  readonly createWriteStream?: (file: string) => NodeStream.Writable;
  readonly log?: (line: string) => void;
}

export type FetchOutcome = { readonly path: string; readonly source: "cache" | "download" };

async function download(clip: TestClip, url: string, partial: string, options: FetchOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new TestMediaError(`${clip.id}: ${url} answered HTTP ${response.status}`);
  }
  const open = options.createWriteStream ?? ((file: string) => NodeFS.createWriteStream(file));
  try {
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body as never),
      open(partial),
    );
  } catch (error) {
    const readable = describeWriteError(error, partial);
    throw readable ? new TestMediaError(`${clip.id}: ${readable}`) : error;
  }
}

/**
 * Make sure `clip` is in the cache with the right bytes. A cached file that verifies is reused
 * with no network call; a cached file that does not is deleted and reported. A download is
 * written to `<file>.part`, verified, and only then renamed into place, so a failed or tampered
 * download leaves nothing behind.
 */
export async function fetchClip(clip: TestClip, options: FetchOptions): Promise<FetchOutcome> {
  const log = options.log ?? (() => {});
  const target = NodePath.join(options.dir, clip.file);
  if (NodeFS.existsSync(target)) {
    const problem = verifyClipFile(clip, target);
    if (problem === undefined) return { path: target, source: "cache" };
    NodeFS.rmSync(target, { force: true });
    throw new TestMediaError(`${problem}. Removed the cached copy; run pnpm media:fetch again.`);
  }
  try {
    NodeFS.mkdirSync(options.dir, { recursive: true });
  } catch (error) {
    throw new TestMediaError(
      `${clip.id}: ${describeWriteError(error, options.dir) ?? String(error)}`,
    );
  }
  const partial = `${target}.part`;
  const failures: string[] = [];
  for (const url of [clip.url, ...(clip.mirrors ?? [])]) {
    log(`${clip.id}: downloading ${url}`);
    try {
      await download(clip, url, partial, options);
      const problem = verifyClipFile(clip, partial);
      if (problem !== undefined) throw new TestMediaError(problem);
      NodeFS.renameSync(partial, target);
      return { path: target, source: "download" };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      NodeFS.rmSync(partial, { force: true });
    }
  }
  throw new TestMediaError(failures.join("\n"));
}
