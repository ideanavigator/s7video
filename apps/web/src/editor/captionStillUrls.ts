// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The player's caption stills by key (S7V-079). `captions.stills` names each still; the bytes come
 * from the asset route once per key and stay here as object URLs, so a cut fetches only the stills
 * it makes new. The URL's token changes with every reply, so the HTTP cache can't do this.
 */
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { CaptionStillsResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** As long as the reply's query is kept once nothing shows it. */
const IDLE_TTL_MS = 5 * 60_000;

/** A reply whose stills have all loaded, with one URL per still (null for one that failed). */
export interface ShownCaptionStills {
  readonly stills: CaptionStillsResult;
  readonly urls: ReadonlyArray<string | null>;
}

/** What the overlay renders from; replaced, never changed, when a load lands. */
export interface CaptionStillsSnapshot {
  readonly settled: ReadonlyMap<string, string | null>;
  readonly shown: ShownCaptionStills | null;
}

const keysOf = (stills: CaptionStillsResult) =>
  stills.stills.map((name) => `${stills.folder}/${name}`);

/** Every still of `stills` from the snapshot, or null while one is still loading. */
export function settledCaptionStills(
  snapshot: CaptionStillsSnapshot,
  stills: CaptionStillsResult,
): ReadonlyArray<string | null> | null {
  const urls: Array<string | null> = [];
  for (const key of keysOf(stills)) {
    const url = snapshot.settled.get(key);
    if (url === undefined) return null;
    urls.push(url);
  }
  return urls;
}

const fetchStill = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    return response.ok ? URL.createObjectURL(await response.blob()) : null;
  } catch {
    return null;
  }
};

/** One project's stills. Only the newest `load` lands; `dispose` revokes every URL. */
class CaptionStillCache {
  readonly #settled = new Map<string, string | null>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #latest: CaptionStillsResult | null = null;
  #snapshot: CaptionStillsSnapshot = { settled: new Map(), shown: null };
  #disposed = false;

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): CaptionStillsSnapshot => this.#snapshot;

  /**
   * Fetches the stills of `stills` not loaded before, then shows it and frees the stills it no
   * longer names. A failed still is shown as null and asked for again with the next reply.
   */
  async load(stills: CaptionStillsResult, httpBaseUrl: string): Promise<void> {
    this.#latest = stills;
    const keys = keysOf(stills);
    await Promise.all(
      keys.map((key, index) =>
        this.#settled.has(key)
          ? undefined
          : this.#fetchOnce(key, `${stills.stillsUrl}${stills.stills[index]}`, httpBaseUrl),
      ),
    );
    if (this.#disposed || this.#latest !== stills) return;
    const urls = keys.map((key) => this.#settled.get(key) ?? null);
    const keep = new Set(keys);
    for (const [key, url] of this.#settled) {
      if (keep.has(key) && url !== null) continue;
      this.#settled.delete(key);
      if (url !== null) URL.revokeObjectURL(url);
    }
    this.#snapshot = { settled: new Map(this.#settled), shown: { stills, urls } };
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#disposed = true;
    for (const url of this.#settled.values()) {
      if (url !== null) URL.revokeObjectURL(url);
    }
    this.#settled.clear();
    this.#listeners.clear();
  }

  #fetchOnce(key: string, relativeUrl: string, httpBaseUrl: string): Promise<void> {
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      const url = resolveAssetUrl(httpBaseUrl, relativeUrl);
      pending = (url === null ? Promise.resolve(null) : fetchStill(url)).then((objectUrl) => {
        this.#pending.delete(key);
        if (!this.#disposed) this.#settled.set(key, objectUrl);
        else if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      });
      this.#pending.set(key, pending);
    }
    return pending;
  }
}

/**
 * The project's still cache, alive while an overlay shows the project and for the query's idle
 * time after; then every object URL is revoked.
 */
export const captionStillCacheAtom = Atom.family((projectKey: string) =>
  Atom.make((get) => {
    const cache = new CaptionStillCache();
    get.addFinalizer(() => cache.dispose());
    return cache;
  }).pipe(Atom.setIdleTTL(IDLE_TTL_MS), Atom.withLabel(`web-caption-still-cache:${projectKey}`)),
);
