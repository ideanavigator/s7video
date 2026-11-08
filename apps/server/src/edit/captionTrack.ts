// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The edit's transcript caption track (S7V-075): which transcripts caption it, and the
 * `setCaptions` that keeps it in step with the video track. `EditDocumentService.apply` adds that
 * op to the same change whenever the video track's items change, so captions never drift and
 * undo puts the edit and its captions back together.
 */
import type { CaptionTranscript } from "@t3tools/shared/captionWords";
import {
  captionItemsFor,
  captionMediaOf,
  sameCaptions,
  transcriptCaptionTrackOf,
} from "@t3tools/shared/captionWords";
import type { EditDocument, EditMedia, EditOp } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { mediaFingerprint } from "../transcript/mediaFingerprint.ts";
import { readCachedTranscript, transcriptCacheDir } from "../transcript/transcriptCache.ts";

export interface CaptionTranscripts {
  readonly transcripts: ReadonlyMap<string, CaptionTranscript>;
  /** Media on the video track with sound but no cached transcript (or an unreadable one). */
  readonly missing: ReadonlyArray<string>;
}

/** The cached transcripts of the media the edit's captions come from. */
export const loadCaptionTranscripts = Effect.fn("captionTrack.loadCaptionTranscripts")(function* (
  root: string,
  document: EditDocument,
) {
  const path = yield* Path.Path;
  const cacheDir = transcriptCacheDir(path, root);
  const locate = (media: EditMedia) =>
    media.path !== undefined ? path.resolve(root, media.path) : path.resolve(media.reference ?? "");
  const transcripts = new Map<string, CaptionTranscript>();
  const missing: string[] = [];
  for (const id of captionMediaOf(document)) {
    const media = document.media.find((entry) => entry.id === id)!;
    const found = yield* mediaFingerprint(locate(media)).pipe(
      Effect.flatMap((fingerprint) => readCachedTranscript(cacheDir, fingerprint)),
      Effect.orElseSucceed(() => null),
    );
    if (found === null) missing.push(id);
    else transcripts.set(id, found);
  }
  return { transcripts, missing } satisfies CaptionTranscripts;
});

const videoItemsOf = (document: EditDocument) =>
  JSON.stringify(document.tracks.find((track) => track.kind === "video")?.items ?? []);

/**
 * The `setCaptions` that rebuilds the transcript caption track of `after`, when the change from
 * `before` touched the video track and the captions no longer match; else none. A caption track
 * without the transcript mark (written by hand) is never rebuilt.
 */
export const rebuildCaptionOps = Effect.fn("captionTrack.rebuildCaptionOps")(function* (
  root: string,
  before: EditDocument,
  after: EditDocument,
) {
  const track = transcriptCaptionTrackOf(after);
  if (track === undefined || videoItemsOf(before) === videoItemsOf(after)) return [];
  const { transcripts } = yield* loadCaptionTranscripts(root, after);
  const captions = captionItemsFor(after, transcripts);
  if (sameCaptions(track, captions)) return [];
  return [{ _tag: "setCaptions", trackId: track.id, captions }] satisfies EditOp[];
});
