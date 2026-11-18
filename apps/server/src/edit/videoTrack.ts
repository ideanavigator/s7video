// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Where a chat tool puts a clip on the video track, shared by silence removal and video_assemble
// (S7V-093) so the two can't drift: a new project's edit has no tracks, and either may come first.
import type { EditDocument, EditMedia, EditOp } from "@t3tools/contracts";

import { allIds } from "./applyEditOps.ts";
import { canvasForClip } from "./canvasForClip.ts";

/**
 * What a tool that needs video on the timeline tells the agent when there is none, so it places
 * the clip itself: the Editor has no way to (S7V-093), so the user can't be asked to.
 */
export const ASSEMBLE_FIRST =
  "Put the clip on it first with video_assemble: in 0, duration its durationFrames from video_edit_read.";

/**
 * The video track holding `mediaId`, else the first video track, else a new `V<n>` (the first id
 * not taken) with the `addTrack` op that adds it. `items` is the chosen track's, empty when new.
 */
export function videoTrackFor(document: EditDocument, mediaId?: string) {
  const videoTracks = document.tracks.flatMap((track) => (track.kind === "video" ? [track] : []));
  const holding =
    mediaId === undefined
      ? undefined
      : videoTracks.find((track) => track.items.some((item) => item.media === mediaId));
  const track = holding ?? videoTracks[0];
  if (track !== undefined) return { trackId: track.id, items: track.items, addTrack: [] };
  const taken = allIds(document);
  let index = 1;
  while (taken.has(`V${index}`)) index++;
  const trackId = `V${index}`;
  return {
    trackId,
    items: [],
    addTrack: [{ _tag: "addTrack", track: { kind: "video", id: trackId, items: [] } } as const],
  };
}

/**
 * The first clip on a timeline with no video gives the edit its shape, in the same step, unless
 * the user already chose one (S7V-061): a `setCanvas`, or nothing.
 */
export function firstClipCanvasOps(document: EditDocument, media: EditMedia): EditOp[] {
  const empty = document.tracks.every(
    (track) => track.kind !== "video" || track.items.length === 0,
  );
  const canvas =
    empty && document.metadata.canvasChosen !== true ? canvasForClip(media.probe) : undefined;
  if (
    canvas === undefined ||
    (canvas.width === document.canvas.width && canvas.height === document.canvas.height)
  ) {
    return [];
  }
  return [{ _tag: "setCanvas", canvas, fromClip: true }];
}
