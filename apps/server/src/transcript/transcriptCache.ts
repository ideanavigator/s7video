// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A clip's cached transcript, `.s7cache/transcripts/<sha256>.json`, read only when it belongs to
 * that exact file (same fingerprint). Shared by the transcript service and the caption track
 * (S7V-075), which reads it under the edit's lock and so cannot depend on that service.
 */
import { type MediaFingerprint, Transcript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeTranscript = Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript));

export const transcriptCacheDir = (path: Path.Path, projectRoot: string) =>
  path.join(projectRoot, ".s7cache", "transcripts");

/** The transcript, null when none is cached for this file; a cache file that does not decode fails. */
export const readCachedTranscript = Effect.fn("readCachedTranscript")(function* (
  cacheDir: string,
  fingerprint: MediaFingerprint,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(cacheDir, `${fingerprint.sha256}.json`))
    .pipe(Effect.option);
  if (text._tag === "None") return null;
  const transcript = yield* decodeTranscript(text.value);
  const same =
    transcript.mediaFingerprint.sha256 === fingerprint.sha256 &&
    transcript.mediaFingerprint.size === fingerprint.size;
  return same ? transcript : null;
});
