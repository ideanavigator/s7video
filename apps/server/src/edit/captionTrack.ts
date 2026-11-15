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
import type {
  BurnedInCaptions,
  EditCaptionTrack,
  EditDocument,
  EditMedia,
  EditOp,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { mediaFingerprint } from "../transcript/mediaFingerprint.ts";
import { readCachedTranscript, transcriptCacheDir } from "../transcript/transcriptCache.ts";

export interface CaptionTranscripts {
  readonly transcripts: ReadonlyMap<string, CaptionTranscript>;
  /** Media on the video track with sound but no cached transcript (or an unreadable one). */
  readonly missing: ReadonlyArray<string>;
  /** Media whose picture already shows captions (S7V-099), with where; unchecked clips aren't listed. */
  readonly burnedIn: ReadonlyMap<string, BurnedInCaptions["region"]>;
}

/** Media captioned in the transcript track: the user has said yes to captions over these. */
export const captionedMedia = (document: EditDocument): ReadonlySet<string> =>
  new Set(
    (transcriptCaptionTrackOf(document)?.items ?? []).flatMap((item) => {
      const media = captionMediaOfItem(item);
      return media === undefined ? [] : [media];
    }),
  );

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
  const burnedIn = new Map<string, BurnedInCaptions["region"]>();
  for (const id of captionMediaOf(document)) {
    const media = document.media.find((entry) => entry.id === id)!;
    const found = yield* mediaFingerprint(locate(media)).pipe(
      Effect.flatMap((fingerprint) => readCachedTranscript(cacheDir, fingerprint)),
      Effect.orElseSucceed(() => null),
    );
    if (found === null) missing.push(id);
    else {
      transcripts.set(id, found);
      if (found.burnedInCaptions?.found === true) burnedIn.set(id, found.burnedInCaptions.region);
    }
  }
  return { transcripts, missing, burnedIn } satisfies CaptionTranscripts;
});

const videoItemsOf = (document: EditDocument) =>
  JSON.stringify(document.tracks.find((track) => track.kind === "video")?.items ?? []);

/**
 * The rebuilt track's captions: the readable clips' from their transcripts, and the `unreadable`
 * clips' carried through the change from `before` (`carryCaptions`). Pure.
 */
export const mergeCaptionTrack = (
  before: EditDocument,
  after: EditDocument,
  track: EditCaptionTrack,
  transcripts: ReadonlyMap<string, CaptionTranscript>,
  unreadable: ReadonlyArray<string>,
) => {
  const missing = new Set(unreadable);
  const kept = track.items.filter((item) => missing.has(captionMediaOfItem(item) ?? ""));
  const rebuilt = captionItemsFor(after, transcripts);
  return [...rebuilt, ...carryCaptions(before, after, kept, rebuilt)].sort(
    (a, b) => a.start - b.start,
  );
};

/**
 * The `setCaptions` rebuilding `after`'s transcript track when the change touched the video track.
 * A clip whose transcript can't be read keeps its items, carried through the cut. A clip showing
 * captions in its picture stays out unless the track captioned it before (S7V-099).
 */
export const rebuildCaptionOps = Effect.fn("captionTrack.rebuildCaptionOps")(function* (
  root: string,
  before: EditDocument,
  after: EditDocument,
) {
  const track = transcriptCaptionTrackOf(after);
  if (track === undefined || videoItemsOf(before) === videoItemsOf(after)) return [];
  const { transcripts, missing, burnedIn } = yield* loadCaptionTranscripts(root, after);
  const confirmed = captionedMedia(before);
  const allowed = new Map(
    [...transcripts].filter(([media]) => !burnedIn.has(media) || confirmed.has(media)),
  );
  const captions = mergeCaptionTrack(before, after, track, allowed, missing);
  if (sameCaptions(track, captions)) return [];
  return [{ _tag: "setCaptions", trackId: track.id, captions }] satisfies EditOp[];
});
