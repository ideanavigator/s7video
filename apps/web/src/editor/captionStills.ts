// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The player's caption overlay (S7V-075): which still shows at a frame, and when the stills must
 * be fetched again. Pure, so the frame lookup runs outside React on every played frame.
 */
import type { CaptionStillsResult, EditDocument } from "@t3tools/contracts";

/**
 * Changes exactly when the stills could: the captions, the canvas, the rate or where the video
 * ends (chunks are clipped to it). A cut that leaves all of these alone fetches nothing.
 */
export function captionStillsSignature(document: EditDocument): string {
  const video = document.tracks.find((track) => track.kind === "video");
  const end = Math.max(0, ...(video?.items ?? []).map((item) => item.start + item.duration));
  const captions = document.tracks.filter((track) => track.kind === "caption");
  if (!captions.some((track) => track.items.length > 0)) return "none";
  return JSON.stringify([document.canvas, document.fps, end, captions]);
}

/** The still shown at `frame`, or -1: chunks are sorted, disjoint and `end` exclusive. */
export function stillAt(chunks: CaptionStillsResult["chunks"], frame: number): number {
  let low = 0;
  let high = chunks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const chunk = chunks[middle]!;
    if (frame < chunk.start) high = middle - 1;
    else if (frame >= chunk.end) low = middle + 1;
    else return chunk.still;
  }
  return -1;
}
