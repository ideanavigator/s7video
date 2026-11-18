// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-079: a project's caption stills are kept by key while something shows the project, and every
 * object URL is revoked once nothing has shown it for the query's idle time.
 */
import type { CaptionStillsResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { captionStillCacheAtom, settledCaptionStills } from "./captionStillUrls";

const BASE = "http://127.0.0.1:3773/";
const STILLS_URL = "/api/assets/payload.signature/";

const reply = (texts: ReadonlyArray<string>, missing: ReadonlyArray<string> = []) => {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const name = new URL(String(input)).pathname.slice(STILLS_URL.length);
    requests.push(name);
    return missing.includes(name)
      ? new Response(null, { status: 404 })
      : new Response(new Blob([`png:${name}`]));
  });
  const stills: CaptionStillsResult = {
    key: texts.join("|"),
    width: 1080,
    height: 1920,
    chunks: texts.map((_, index) => ({ start: index * 10, end: index * 10 + 5, still: index })),
    folder: "look",
    stillsUrl: STILLS_URL,
    stills: texts.map((text) => `${text}.png`),
    missing: [],
  };
  return { stills, requests };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("captionStillCacheAtom", () => {
  it("revokes every still once nothing has shown the project for the idle time", async () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const atom = captionStillCacheAtom("project-closed");
    const release = registry.mount(atom);
    const cache = registry.get(atom);
    const { stills } = reply(["one", "two"]);
    await cache.load(stills, BASE);
    const urls = settledCaptionStills(cache.snapshot(), stills)!;
    expect(urls).toHaveLength(2);
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    release();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(revoke).not.toHaveBeenCalled();
    // Shown again within the idle time: the same stills, nothing freed.
    const again = registry.mount(atom);
    expect(registry.get(atom)).toBe(cache);
    again();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
    expect(revoke.mock.calls.map(([url]) => url).toSorted()).toEqual([...urls].toSorted());
    expect(registry.get(atom)).not.toBe(cache);
  });

  it("fetches only new stills, frees the ones a newer reply drops, and retries a failure", async () => {
    const registry = AtomRegistry.make();
    const atom = captionStillCacheAtom("project-cut");
    const release = registry.mount(atom);
    const cache = registry.get(atom);
    const first = reply(["one", "two"], ["two.png"]);
    await cache.load(first.stills, BASE);
    expect(first.requests).toEqual(["one.png", "two.png"]);
    expect(cache.snapshot().shown?.urls[1]).toBeNull();
    const [oneUrl] = cache.snapshot().shown!.urls;
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const cut = reply(["two", "three"]);
    await cache.load(cut.stills, BASE);
    expect(cut.requests).toEqual(["two.png", "three.png"]);
    expect(revoke.mock.calls).toEqual([[oneUrl]]);
    expect(settledCaptionStills(cache.snapshot(), cut.stills)).not.toContain(null);
    release();
  });

  it("lands only the newest reply when an older one finishes later", async () => {
    const registry = AtomRegistry.make();
    const atom = captionStillCacheAtom("project-race");
    const release = registry.mount(atom);
    const cache = registry.get(atom);
    let finish = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const older = reply(["slow"]);
    const fetchSpy = vi.mocked(fetch);
    const answer = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementationOnce(async (input) => {
      await held;
      return answer(input);
    });
    const loadingOlder = cache.load(older.stills, BASE);
    const newer = reply(["fast"]);
    await cache.load(newer.stills, BASE);
    finish();
    await loadingOlder;
    expect(cache.snapshot().shown?.stills).toBe(newer.stills);
    release();
  });
});
