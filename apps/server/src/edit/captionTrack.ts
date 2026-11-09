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
  carryCaptions,
  captionMediaOf,
  captionMediaOfItem,
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
 * The `setCaptions` rebuilding `after`'s transcript caption track when the change touched the video
 * track; a hand-written track is never rebuilt. A clip whose transcript can't be read keeps its
 * items, carried through the cut (`carryCaptions`); the player names the clip.
 */
export const rebuildCaptionOps = Effect.fn("captionTrack.rebuildCaptionOps")(function* (
  root: string,
  before: EditDocument,
  after: EditDocument,
) {
  const track = transcriptCaptionTrackOf(after);
  if (track === undefined || videoItemsOf(before) === videoItemsOf(after)) return [];
  const { transcripts, missing } = yield* loadCaptionTranscripts(root, after);
  const unreadable = new Set(missing);
  const kept = track.items.filter((item) => unreadable.has(captionMediaOfItem(item) ?? ""));
  const rebuilt = captionItemsFor(after, transcripts);
  const captions = [...rebuilt, ...carryCaptions(before, after, kept, rebuilt)].toSorted(
    (a, b) => a.start - b.start,
  );
  if (sameCaptions(track, captions)) return [];
  return [{ _tag: "setCaptions", trackId: track.id, captions }] satisfies EditOp[];
});
