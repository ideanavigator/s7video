// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A version's line for a change whose caller gave none (S7V-069): an Editor action on the
 * timeline or transcript, worded from its ops. Tools and imports pass their own line.
 */
import type { EditOp, EditOrigin } from "@t3tools/contracts";

const PHRASES: Record<EditOp["_tag"], string> = {
  setKeepRanges: "Cut parts of a clip",
  setCaptions: "Changed the captions",
  insertItem: "Added to the timeline",
  moveItem: "Moved an item",
  trimItem: "Trimmed an item",
  splitItem: "Split an item",
  deleteItem: "Deleted from the timeline",
  restoreRange: "Put back a cut part",
  setItemProps: "Changed an item",
  addTrack: "Added a track",
  setCaptionStyle: "Changed the caption style",
  setTrackProps: "Changed a track",
  putMedia: "Added a clip to Assets",
  removeMedia: "Removed a clip from Assets",
  setMarkers: "Changed the markers",
  setCanvas: "Changed the video's shape",
};

/** Item ops name how many items they changed, so a group move is one counted line (S7V-034). */
const COUNTED: Partial<Record<EditOp["_tag"], (count: number) => string>> = {
  moveItem: (count) => `Moved ${count} items`,
  trimItem: (count) => `Trimmed ${count} items`,
  splitItem: (count) => `Split ${count} items`,
  deleteItem: (count) => `Deleted ${count} items from the timeline`,
};

const itemsOf = (op: EditOp) => (op._tag === "deleteItem" ? op.itemIds.length : 1);

/** One line naming each kind of change once, in the order the ops make them. */
export const describeOps = (ops: ReadonlyArray<EditOp>, origin?: EditOrigin): string => {
  // A text edit's splits and deletes are one change to the user (S7V-038).
  if (origin === "transcript" && ops.length > 0) {
    return ops.every((op) => op._tag === "restoreRange")
      ? "Put back words in the transcript"
      : "Cut words in the transcript";
  }
  const counts = new Map<EditOp["_tag"], number>();
  for (const op of ops) counts.set(op._tag, (counts.get(op._tag) ?? 0) + itemsOf(op));
  if (counts.size === 0) return "Changed the edit";
  return [...counts]
    .map(([tag, count]) => (count > 1 ? (COUNTED[tag]?.(count) ?? PHRASES[tag]) : PHRASES[tag]))
    .join("; ");
};
