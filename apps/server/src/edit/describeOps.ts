// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A version's line for a change whose caller gave none (S7V-069): an Editor action on the
 * timeline or transcript, worded from its ops. Tools and imports pass their own line.
 */
import type { EditOp } from "@t3tools/contracts";

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

/** One line naming each kind of change once, in the order the ops make them. */
export const describeOps = (ops: ReadonlyArray<EditOp>): string => {
  const phrases = [...new Set(ops.map((op) => PHRASES[op._tag]))];
  if (phrases.length === 0) return "Changed the edit";
  return phrases.join("; ");
};
