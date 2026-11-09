// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Timeline gestures as edit ops (S7V-034). A finished gesture is a delta, planned again against
 * the rows at send time, so it is one `EditOp[]` batch: one `edit.apply`, one history step. Ops
 * name one item per link group; the server carries the linked items (`applyEditOps.ts`).
 */
import type { EditOp } from "@t3tools/contracts";

import type { PreviewBlock } from "./dragPreview";
import type { MoveGesture } from "./controllers/elementInteractionController";
import {
  buildMoveGroup,
  indexItems,
  oneIdPerLink,
  resolveGroupMove,
  withLinkedItems,
  type MoveRefusal,
} from "./controllers/groupMove";
import { buildResizeMembers, computeGroupResize } from "./controllers/groupResize";
import type { TrimGesture } from "./controllers/resizeController";
import type { TimelineRow } from "./timelineModel";

export type TimelineGesture = MoveGesture | TrimGesture;

export interface PlannedGesture {
  readonly ops: ReadonlyArray<EditOp>;
  /** Why it cannot be written; `missing` when an item is gone from the edit. */
  readonly refused: MoveRefusal | "missing" | null;
  readonly blocks: ReadonlyArray<PreviewBlock>;
}

const MISSING: PlannedGesture = { ops: [], refused: "missing", blocks: [] };

export function planGesture(
  rows: ReadonlyArray<TimelineRow>,
  gesture: TimelineGesture,
): PlannedGesture {
  const index = indexItems(rows);
  const anchorId = gesture.itemIds[0];
  if (anchorId === undefined || gesture.itemIds.some((id) => !index.has(id))) return MISSING;
  if (gesture.kind === "move") {
    const group = buildMoveGroup(rows, anchorId, gesture.itemIds);
    if (group === null) return MISSING;
    const targetRowIndex =
      gesture.toRowId === null
        ? group.anchor.rowIndex
        : rows.findIndex((row) => row.id === gesture.toRowId);
    if (targetRowIndex === -1) return MISSING;
    const result = resolveGroupMove(
      group,
      rows,
      group.anchor.start + gesture.delta,
      targetRowIndex,
    );
    const blocks = result.moves.map((move) => ({
      itemId: move.itemId,
      rowIndex: move.toRowIndex,
      start: move.start,
      duration: move.duration,
    }));
    if (result.refused !== null) return { ops: [], refused: result.refused, blocks };
    const byId = new Map(result.moves.map((move) => [move.itemId, move]));
    const ops: EditOp[] = [];
    for (const id of oneIdPerLink(index, gesture.itemIds)) {
      const move = byId.get(id)!;
      const from = index.get(id)!.item;
      if (move.start === from.start && move.toRowIndex === move.fromRowIndex) continue;
      ops.push(
        move.toRowIndex === move.fromRowIndex
          ? { _tag: "moveItem", itemId: id, start: move.start }
          : {
              _tag: "moveItem",
              itemId: id,
              start: move.start,
              toTrackId: rows[move.toRowIndex]!.id,
            },
      );
    }
    return { ops, refused: null, blocks };
  }
  const members = buildResizeMembers(rows, anchorId, gesture.itemIds);
  if (rows.some((row, rowIndex) => row.locked && members.some((m) => m.rowIndex === rowIndex))) {
    return { ops: [], refused: "locked", blocks: [] };
  }
  const result = computeGroupResize(members, gesture.side, gesture.delta);
  const blocks = result.updates.map((update) => ({
    itemId: update.itemId,
    rowIndex: update.rowIndex,
    start: update.start,
    duration: update.duration,
  }));
  if (result.delta === 0) return { ops: [], refused: null, blocks };
  const byId = new Map(result.updates.map((update) => [update.itemId, update]));
  const ops: EditOp[] = oneIdPerLink(index, gesture.itemIds).map((id) => {
    const update = byId.get(id)!;
    return {
      _tag: "trimItem",
      itemId: id,
      edge: gesture.side,
      frame: gesture.side === "start" ? update.start : update.start + update.duration,
    };
  });
  return { ops, refused: null, blocks };
}

const editableItems = (rows: ReadonlyArray<TimelineRow>) =>
  rows.filter((row) => row.real && !row.locked).flatMap((row) => row.items);

/**
 * Splits the selected clips (with their linked items) at `frame`, or every clip under it on an
 * unlocked track when nothing is selected. A frame on a clip's first frame or past its last is
 * not inside it, so a split there is skipped, not an error.
 */
export function splitOps(
  rows: ReadonlyArray<TimelineRow>,
  selected: ReadonlySet<string>,
  frame: number,
): EditOp[] {
  const chosen = selected.size > 0 ? withLinkedItems(rows, selected) : null;
  const under = editableItems(rows)
    .filter((item) => chosen === null || chosen.has(item.id))
    .filter((item) => item.start < frame && frame < item.start + item.duration)
    .map((item) => item.id);
  return oneIdPerLink(indexItems(rows), under).map((itemId) => ({
    _tag: "splitItem",
    itemId,
    atFrame: frame,
  }));
}

/** Deletes the selected clips (and their linked items); ripple closes each track's gap. */
export function deleteOps(
  rows: ReadonlyArray<TimelineRow>,
  selected: ReadonlySet<string>,
  ripple: boolean,
): EditOp[] {
  const editable = new Set(editableItems(rows).map((item) => item.id));
  const ids = [...withLinkedItems(rows, selected)].filter((id) => editable.has(id));
  if (ids.length === 0) return [];
  return [{ _tag: "deleteItem", itemIds: oneIdPerLink(indexItems(rows), ids), ripple }];
}
