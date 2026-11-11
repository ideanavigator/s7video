// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The player's caption stills by key (S7V-079). `captions.stills` names each still; the bytes come
 * from the asset route once per key and stay here as object URLs, so a cut fetches only the stills
 * it makes new. The URL's token changes with every reply, so the HTTP cache can't do this.
 */
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { CaptionStillsResult } from "@t3tools/contracts";

/** Per project, each still's key (`folder/name`) and its object URL, or null if it failed. */
const loadedByProject = new Map<string, Map<string, Promise<string | null>>>();

const keysOf = (stills: CaptionStillsResult) =>
  stills.stills.map((name) => `${stills.folder}/${name}`);

const fetchStill = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    return response.ok ? URL.createObjectURL(await response.blob()) : null;
  } catch {
    return null;
  }
};

/**
 * One URL per still of `stills`, fetching only keys not loaded before. A failed still is null,
 * and forgotten so the next reply asks for it again.
 */
export async function loadCaptionStills(
  projectKey: string,
  stills: CaptionStillsResult,
  httpBaseUrl: string,
): Promise<ReadonlyArray<string | null>> {
  let loaded = loadedByProject.get(projectKey);
  if (loaded === undefined) {
    loaded = new Map();
    loadedByProject.set(projectKey, loaded);
  }
  const known = loaded;
  const keys = keysOf(stills);
  const urls = await Promise.all(
    keys.map((key, index) => {
      let still = known.get(key);
      if (still === undefined) {
        const url = resolveAssetUrl(httpBaseUrl, `${stills.stillsUrl}${stills.stills[index]}`);
        still = url === null ? Promise.resolve(null) : fetchStill(url);
        known.set(key, still);
      }
      return still;
    }),
  );
  keys.forEach((key, index) => {
    if (urls[index] === null) known.delete(key);
  });
  return urls;
}

/** Frees the stills `stills` no longer names, once the overlay shows `stills`. */
export function forgetOtherCaptionStills(projectKey: string, stills: CaptionStillsResult): void {
  const loaded = loadedByProject.get(projectKey);
  if (loaded === undefined) return;
  const keep = new Set(keysOf(stills));
  for (const [key, still] of loaded) {
    if (keep.has(key)) continue;
    loaded.delete(key);
    void still.then((url) => {
      if (url !== null) URL.revokeObjectURL(url);
    });
  }
}
