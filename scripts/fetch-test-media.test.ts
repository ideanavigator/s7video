// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - fetchClip writes a real temp cache dir.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { fetchClip, testMediaDir, type TestClip } from "./lib/test-media.ts";

const BYTES = Buffer.from("not really a video, but bytes all the same\n".repeat(64));
const SHA = NodeCrypto.createHash("sha256").update(BYTES).digest("hex");
const CLIP: TestClip = {
  id: "sample-01",
  file: "sample-01.webm",
  url: "https://example.invalid/sample-01.webm",
  sha256: SHA,
  size: BYTES.length,
  licence: "CC0-1.0",
  sourcePage: "https://example.invalid/sample",
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-media-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function serving(body: Buffer, calls: string[] = []): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(new Uint8Array(body));
  }) as typeof globalThis.fetch;
}
const offline = (async () => {
  throw new Error("network used");
}) as typeof globalThis.fetch;

describe("fetchClip", () => {
  it("fetch-test-media verifies sha256 and size", async () => {
    const dir = tempDir();
    const outcome = await fetchClip(CLIP, { dir, fetch: serving(BYTES) });
    expect(outcome).toEqual({ path: NodePath.join(dir, CLIP.file), source: "download" });
    expect(NodeFS.readFileSync(outcome.path)).toEqual(BYTES);
    expect(NodeFS.readdirSync(dir)).toEqual([CLIP.file]);
  });

  it("fetch-test-media reuses the cache offline", async () => {
    const dir = tempDir();
    await fetchClip(CLIP, { dir, fetch: serving(BYTES) });
    expect(await fetchClip(CLIP, { dir, fetch: offline })).toEqual({
      path: NodePath.join(dir, CLIP.file),
      source: "cache",
    });
  });

  it("lets two concurrent fetches of the same clip both succeed", async () => {
    const dir = tempDir();
    const results = await Promise.all([
      fetchClip(CLIP, { dir, fetch: serving(BYTES) }),
      fetchClip(CLIP, { dir, fetch: serving(BYTES) }),
    ]);
    expect(results.map((result) => result.source)).toEqual(["download", "download"]);
    expect(NodeFS.readdirSync(dir)).toEqual([CLIP.file]);
    expect(NodeFS.readFileSync(NodePath.join(dir, CLIP.file))).toEqual(BYTES);
  });

  it("tries the mirrors in order when the main URL fails", async () => {
    const dir = tempDir();
    const calls: string[] = [];
    const flaky = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url).includes("mirror")
        ? new Response(new Uint8Array(BYTES))
        : new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    const clip = { ...CLIP, mirrors: ["https://mirror.invalid/sample-01.webm"] };
    expect((await fetchClip(clip, { dir, fetch: flaky })).source).toBe("download");
    expect(calls).toEqual([CLIP.url, "https://mirror.invalid/sample-01.webm"]);
  });
});

describe("fetchClip edge cases", () => {
  it("should fail on checksum mismatch", async () => {
    const dir = tempDir();
    const tampered = Buffer.from(BYTES);
    tampered[0] = 0x4e;
    const actual = NodeCrypto.createHash("sha256").update(tampered).digest("hex");
    await expect(fetchClip(CLIP, { dir, fetch: serving(tampered) })).rejects.toThrow(
      `sample-01: sha256 mismatch: expected ${SHA}, got ${actual}`,
    );
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("should fail on a tampered manifest", async () => {
    const dir = tempDir();
    const wrong = "0".repeat(64);
    await expect(
      fetchClip({ ...CLIP, sha256: wrong }, { dir, fetch: serving(BYTES) }),
    ).rejects.toThrow(`sample-01: sha256 mismatch: expected ${wrong}, got ${SHA}`);
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("should remove a tampered cached file and say so", async () => {
    const dir = tempDir();
    const cached = Buffer.from(BYTES);
    cached[1] = 0x00;
    NodeFS.writeFileSync(NodePath.join(dir, CLIP.file), cached);
    await expect(fetchClip(CLIP, { dir, fetch: offline })).rejects.toThrow(
      /sample-01: sha256 mismatch: expected [0-9a-f]{64}, got [0-9a-f]{64}\. Removed/,
    );
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("should fail on truncated download", async () => {
    const dir = tempDir();
    await expect(fetchClip(CLIP, { dir, fetch: serving(BYTES.subarray(0, 100)) })).rejects.toThrow(
      `sample-01: size mismatch: expected ${BYTES.length} bytes, got 100`,
    );
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("should handle disk full in cache", async () => {
    const dir = tempDir();
    const full = () =>
      new NodeStream.Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
        },
      });
    await expect(
      fetchClip(CLIP, { dir, fetch: serving(BYTES), createWriteStream: full }),
    ).rejects.toThrow(
      /sample-01: disk full while writing .*sample-01\.webm\.\d+-[0-9a-f]{8}\.part; free some space or point S7VIDEO_TEST_MEDIA_DIR/,
    );
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });

  it("names the HTTP status when every URL fails", async () => {
    const dir = tempDir();
    const gone = (async () => new Response(null, { status: 410 })) as typeof globalThis.fetch;
    await expect(fetchClip(CLIP, { dir, fetch: gone })).rejects.toThrow(
      `sample-01: ${CLIP.url} answered HTTP 410`,
    );
  });
});

describe("testMediaDir", () => {
  it("uses S7VIDEO_TEST_MEDIA_DIR, else the user cache folder", () => {
    expect(testMediaDir({ S7VIDEO_TEST_MEDIA_DIR: "/tmp/media" })).toBe("/tmp/media");
    expect(testMediaDir({})).toBe(
      NodePath.join(NodeOS.homedir(), "Library", "Caches", "s7video-test-media"),
    );
  });
});
