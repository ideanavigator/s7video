// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A dev download script; no Effect runtime.
// `pnpm media:fetch [clip-id ...]`: download the free-licence test clips in
// fixtures/media/manifest.json into the test-media cache, checking sha256 and size (S7V-031).
import * as NodePath from "node:path";

import { fetchClip, readManifest, testMediaDir } from "./lib/test-media.ts";

export const MANIFEST_PATH = NodePath.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "media",
  "manifest.json",
);

/** Fetch every clip (or the ones named); returns the number of failures. */
export async function fetchTestMedia(ids: ReadonlyArray<string> = []): Promise<number> {
  const manifest = readManifest(MANIFEST_PATH);
  const unknown = ids.filter((id) => !manifest.clips.some((clip) => clip.id === id));
  if (unknown.length > 0) {
    console.error(`media:fetch: no clip named ${unknown.join(", ")} in ${MANIFEST_PATH}`);
    return unknown.length;
  }
  const dir = testMediaDir();
  let failures = 0;
  for (const clip of manifest.clips.filter((c) => ids.length === 0 || ids.includes(c.id))) {
    try {
      const outcome = await fetchClip(clip, { dir, log: (line) => console.log(line) });
      console.log(`${clip.id}: ok (${outcome.source}) ${outcome.path}`);
    } catch (error) {
      failures += 1;
      console.error(
        `media:fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

if (import.meta.main) {
  const failures = await fetchTestMedia(process.argv.slice(2).filter((arg) => arg !== "--"));
  process.exitCode = failures > 0 ? 1 : 0;
}
