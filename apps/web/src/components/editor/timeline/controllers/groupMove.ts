// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), files apps/web/src/timeline/group-move/{build-group,resolve-move,snap}.ts. Ported for S7V-034 from the spike B1 copies.
 *
 * Copyright 2025-2026 OpenCut
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * s7video changes: MediaTime ticks -> integer frames; OpenCut's track sections -> the timeline's rows; only moves onto existing tracks (no new tracks), and onto another row only when the whole group sits on one row; linked items (`linkId`) join the group; a refused move reports why instead of returning null.
 */

import { resolveTimelineSnap, type SnapPoint } from "../vendor/opencut/snapping";
import type { TimelineItem, TimelineRow } from "../timelineModel";
import { canPlaceSpansOnRow } from "./placement";

export interface ItemAt {
  readonly rowIndex: number;
  readonly item: TimelineItem;
}

/** Every item by id, with its row. */
export function indexItems(rows: ReadonlyArray<TimelineRow>): Map<string, ItemAt> {
  const byId = new Map<string, ItemAt>();
  rows.forEach((row, rowIndex) => {
    for (const item of row.items) byId.set(item.id, { rowIndex, item });
  });
  return byId;
}

/** The ids plus every item that shares a link id with one of them. */
export function withLinkedItems(
  rows: ReadonlyArray<TimelineRow>,
  ids: Iterable<string>,
): Set<string> {
  const index = indexItems(rows);
  const result = new Set<string>();
  const links = new Set<string>();
  for (const id of ids) {
    const found = index.get(id);
    if (found === undefined) continue;
    result.add(id);
    if (found.item.linkId !== null) links.add(found.item.linkId);
  }
  if (links.size > 0) {
    for (const row of rows) {
      for (const item of row.items) {
        if (item.linkId !== null && links.has(item.linkId)) result.add(item.id);
      }
    }
  }
  return result;
}

/**
 * One id per link group: the server carries linked items with each op (S7V-034), so the
 * timeline names only one of them. Ids without a link are all kept.
 */
export function oneIdPerLink(index: ReadonlyMap<string, ItemAt>, ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const linkId = index.get(id)?.item.linkId ?? null;
    if (linkId !== null) {
      if (seen.has(linkId)) continue;
      seen.add(linkId);
    }
    result.push(id);
  }
  return result;
}

export interface GroupMember {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly start: number;
  readonly duration: number;
  /** Frames from the anchor's start. */
  readonly offset: number;
}

export interface MoveGroup {
  readonly anchor: GroupMember;
  readonly members: ReadonlyArray<GroupMember>;
}

export function buildMoveGroup(
  rows: ReadonlyArray<TimelineRow>,
  anchorId: string,
  selectedIds: Iterable<string>,
): MoveGroup | null {
  const index = indexItems(rows);
  const anchorAt = index.get(anchorId);
  if (anchorAt === undefined) return null;
  const ids = withLinkedItems(rows, [anchorId, ...selectedIds]);
  const members: GroupMember[] = [];
  for (const id of ids) {
    const found = index.get(id)!;
    members.push({
      itemId: id,
      rowIndex: found.rowIndex,
      start: found.item.start,
      duration: found.item.duration,
      offset: found.item.start - anchorAt.item.start,
    });
  }
  const anchor = members.find((member) => member.itemId === anchorId)!;
  return { anchor, members };
}

/** Edges of every item outside `exclude`, and the playhead, as snap points. */
export function buildSnapPoints(
  rows: ReadonlyArray<TimelineRow>,
  exclude: ReadonlySet<string>,
  playheadFrame: number | null,
): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const row of rows) {
    for (const item of row.items) {
      if (exclude.has(item.id)) continue;
      points.push(
        { time: item.start, type: "element-start", elementId: item.id, trackId: row.id },
        {
          time: item.start + item.duration,
          type: "element-end",
          elementId: item.id,
          trackId: row.id,
        },
      );
    }
  }
  if (playheadFrame !== null) points.push({ time: playheadFrame, type: "playhead" });
  return points;
}

/** Snaps whichever member edge lands closest to a snap point; the rest follow at their offsets. */
export function snapGroupEdges(
  group: MoveGroup,
  anchorStart: number,
  snapPoints: SnapPoint[],
  maxSnapDistance: number,
): { readonly anchorStart: number; readonly snapPoint: SnapPoint | null } {
  let closestDistance = Infinity;
  let snapped = anchorStart;
  let snapPoint: SnapPoint | null = null;
  for (const member of group.members) {
    const memberStart = anchorStart + member.offset;
    const startSnap = resolveTimelineSnap({ targetTime: memberStart, snapPoints, maxSnapDistance });
    if (startSnap.snapPoint && startSnap.snapDistance < closestDistance) {
      closestDistance = startSnap.snapDistance;
      snapped = startSnap.snappedTime - member.offset;
      snapPoint = startSnap.snapPoint;
    }
    const endSnap = resolveTimelineSnap({
      targetTime: memberStart + member.duration,
      snapPoints,
      maxSnapDistance,
    });
    if (endSnap.snapPoint && endSnap.snapDistance < closestDistance) {
      closestDistance = endSnap.snapDistance;
      snapped = endSnap.snappedTime - member.duration - member.offset;
      snapPoint = endSnap.snapPoint;
    }
  }
  return { anchorStart: snapped, snapPoint };
}

export interface PlannedMove {
  readonly itemId: string;
  readonly fromRowIndex: number;
  readonly toRowIndex: number;
  readonly start: number;
  readonly duration: number;
}

export type MoveRefusal = "overlap" | "other-kind" | "locked";

export interface GroupMoveResult {
  readonly moves: ReadonlyArray<PlannedMove>;
  /** Why the move cannot be written; the preview shows it blocked. */
  readonly refused: MoveRefusal | null;
}

/**
 * Places the group with its anchor at `anchorStart` (clamped so nothing starts before frame 0),
 * on `targetRowIndex` when the whole group sits on one row. Non-ripple: the group lands only
 * where there is room.
 */
export function resolveGroupMove(
  group: MoveGroup,
  rows: ReadonlyArray<TimelineRow>,
  anchorStart: number,
  targetRowIndex: number,
): GroupMoveResult {
  const earliestOffset = Math.min(...group.members.map((member) => member.offset));
  const clampedAnchor = Math.max(Math.round(anchorStart), -earliestOffset);
  const oneRow = group.members.every((member) => member.rowIndex === group.anchor.rowIndex);
  const target = rows[targetRowIndex];
  const source = rows[group.anchor.rowIndex]!;
  let toRow = group.anchor.rowIndex;
  let refused: MoveRefusal | null = null;
  if (group.members.some((member) => rows[member.rowIndex]?.locked === true)) refused = "locked";
  else if (oneRow && target !== undefined && targetRowIndex !== group.anchor.rowIndex) {
    if (target.kind !== source.kind || !target.real) refused = "other-kind";
    else if (target.locked) refused = "locked";
    else toRow = targetRowIndex;
  }
  const moves = group.members.map((member) => ({
    itemId: member.itemId,
    fromRowIndex: member.rowIndex,
    toRowIndex: oneRow ? toRow : member.rowIndex,
    start: clampedAnchor + member.offset,
    duration: member.duration,
  }));
  if (refused === null) {
    const exclude = new Set(group.members.map((member) => member.itemId));
    const byRow = new Map<number, PlannedMove[]>();
    for (const move of moves) {
      const list = byRow.get(move.toRowIndex) ?? [];
      list.push(move);
      byRow.set(move.toRowIndex, list);
    }
    for (const [rowIndex, planned] of byRow) {
      if (!canPlaceSpansOnRow(rows[rowIndex]!.items, planned, exclude)) {
        refused = "overlap";
        break;
      }
    }
  }
  return { moves, refused };
}
