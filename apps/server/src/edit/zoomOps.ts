// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A punch-in zoom over timeline frames (S7V-037). Pure: ops from the document. An item the range
 * covers only in part is split at the range's edges (the timeline's own `splitItem`), and each
 * covered part gets the zoom, so the export zooms exactly those frames.
 */
import type { EditDocument, EditFrameRange, EditOp, EditZoom } from "@t3tools/contracts";

/** PO 2026-11-08: a 1.25 punch-in, fixed at the upper third, where a framed face's eyes sit. */
export const DEFAULT_ZOOM = { scale: 1.25, anchorX: 0.5, anchorY: 1 / 3 } as const;
export const ZOOM_SCALE = { min: 1, max: 2 } as const;

export const ZOOM_RANGE_FORMAT =
  "range is one clip-frame range as video_transcript_read shows it, end exclusive: 120-180.";

/** `"120-180"` as clip frames, or null when it is not one range with `from < to`. */
export const parseZoomRange = (text: string) => {
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/u.exec(text);
  if (match === null) return null;
  const [from, to] = [Number(match[1]), Number(match[2])];
  return from < to ? { from, to } : null;
};

/** Ids this module gives the parts a split makes; the server's own ids never take this form. */
const PART_PREFIX = "vz";

/**
 * The ops that zoom `ranges` (timeline frames, end exclusive) on the first video track: splits
 * first, right to left within each item so its id stays on its left part, then one `setItemProps`
 * per covered part.
 */
export function zoomOps(
  document: EditDocument,
  ranges: ReadonlyArray<EditFrameRange>,
  zoom: EditZoom,
): { readonly ops: EditOp[]; readonly items: number } {
  const taken = new Set<string>([
    ...document.media.map((media) => media.id),
    ...document.markers.map((marker) => marker.id),
    ...document.tracks.flatMap((track) => [track.id, ...track.items.map((item) => item.id)]),
  ]);
  let counter = 0;
  const fresh = () => {
    let id: string;
    do id = `${PART_PREFIX}${(counter += 1)}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
  const video = document.tracks.find((track) => track.kind === "video");
  const splits: EditOp[] = [];
  const zoomed: string[] = [];
  for (const item of [...(video?.items ?? [])].sort((a, b) => a.start - b.start)) {
    const itemEnd = item.start + item.duration;
    const covered = ranges
      .map(({ start, end }) => [Math.max(start, item.start), Math.min(end, itemEnd)] as const)
      .filter(([start, end]) => start < end)
      .sort((a, b) => a[0] - b[0]);
    let end = itemEnd;
    for (let index = covered.length - 1; index >= 0; index--) {
      const [from, to] = covered[index]!;
      if (to < end) {
        splits.push({ _tag: "splitItem", itemId: item.id, atFrame: to, newItemId: fresh() });
      }
      if (from > item.start) {
        const middle = fresh();
        splits.push({ _tag: "splitItem", itemId: item.id, atFrame: from, newItemId: middle });
        zoomed.push(middle);
      } else {
        zoomed.push(item.id);
      }
      end = from;
    }
  }
  return {
    ops: [
      ...splits,
      ...zoomed.map((itemId): EditOp => ({ _tag: "setItemProps", itemId, props: { zoom } })),
    ],
    items: zoomed.length,
  };
}
