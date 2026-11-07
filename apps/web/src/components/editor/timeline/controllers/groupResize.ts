// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), files apps/web/src/timeline/group-resize/{types,compute-resize}.ts and the member builder in controllers/resize-controller.ts. Ported for S7V-034 from the spike B1 copies.
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
 * s7video changes: MediaTime ticks -> integer frames, so the delta needs no frame rounding; trimStart/trimEnd -> the source `in` and the media's length in frames; no retiming; sides are edit.json's `start`/`end` edges.
 */

import type { TimelineRow } from "../timelineModel";
import { indexItems, withLinkedItems } from "./groupMove";

export type ResizeSide = "start" | "end";

export interface GroupResizeMember {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly start: number;
  readonly duration: number;
  /** The source frame at `start`; null for an item without media (a caption). */
  readonly in: number | null;
  /** The media's length in frames, when known. */
  readonly mediaFrames: number | null;
  /** The end of the nearest item to the left on the row, or null. */
  readonly leftBound: number | null;
  /** The start of the nearest item to the right on the row, or null. */
  readonly rightBound: number | null;
}

export interface GroupResizeUpdate {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly start: number;
  readonly duration: number;
  readonly in: number | null;
}

export interface GroupResizeResult {
  /** The frames the edge moved, after every member's limits. */
  readonly delta: number;
  readonly updates: ReadonlyArray<GroupResizeUpdate>;
}

const MIN_DURATION = 1;

/** The members a trim of `anchorId` changes: it, the selection, and their linked items. */
export function buildResizeMembers(
  rows: ReadonlyArray<TimelineRow>,
  anchorId: string,
  selectedIds: Iterable<string>,
): GroupResizeMember[] {
  const index = indexItems(rows);
  const selected = [...selectedIds];
  const ids = withLinkedItems(rows, selected.includes(anchorId) ? selected : [anchorId]);
  const members: GroupResizeMember[] = [];
  for (const id of ids) {
    const { rowIndex, item } = index.get(id)!;
    let leftBound: number | null = null;
    let rightBound: number | null = null;
    for (const other of rows[rowIndex]!.items) {
      if (ids.has(other.id)) continue;
      const otherEnd = other.start + other.duration;
      if (otherEnd <= item.start) leftBound = Math.max(leftBound ?? otherEnd, otherEnd);
      if (other.start >= item.start + item.duration) {
        rightBound = Math.min(rightBound ?? other.start, other.start);
      }
    }
    members.push({
      itemId: id,
      rowIndex,
      start: item.start,
      duration: item.duration,
      in: item.mediaId === null ? null : item.in,
      mediaFrames: item.mediaFrames,
      leftBound,
      rightBound,
    });
  }
  return members;
}

function minimumDelta(member: GroupResizeMember, side: ResizeSide): number {
  if (side === "end") return MIN_DURATION - member.duration;
  const leftFloor = (member.leftBound ?? 0) - member.start;
  // The start edge cannot move before the media's first frame.
  return member.in === null ? leftFloor : Math.max(leftFloor, -member.in);
}

function maximumDelta(member: GroupResizeMember, side: ResizeSide): number | null {
  if (side === "start") return member.duration - MIN_DURATION;
  const rightCeiling =
    member.rightBound === null ? null : member.rightBound - (member.start + member.duration);
  if (member.in === null || member.mediaFrames === null) return rightCeiling;
  // The end edge cannot read past the media's last frame.
  const sourceCeiling = member.mediaFrames - (member.in + member.duration);
  return rightCeiling === null ? sourceCeiling : Math.min(rightCeiling, sourceCeiling);
}

/** Moves one edge of every member by the same whole frames, clamped by every member's limits. */
export function computeGroupResize(
  members: ReadonlyArray<GroupResizeMember>,
  side: ResizeSide,
  deltaFrames: number,
): GroupResizeResult {
  if (members.length === 0) return { delta: 0, updates: [] };
  let minimum = -Infinity;
  let maximum = Infinity;
  for (const member of members) {
    minimum = Math.max(minimum, minimumDelta(member, side));
    const memberMaximum = maximumDelta(member, side);
    if (memberMaximum !== null) maximum = Math.min(maximum, memberMaximum);
  }
  // Limits of different members can cross (a long and a one-frame item); then nothing moves.
  const raw = Math.round(deltaFrames);
  const delta = minimum > maximum ? 0 : Math.min(maximum, Math.max(minimum, raw));
  const clean = Object.is(delta, -0) ? 0 : delta;
  return {
    delta: clean,
    updates: members.map((member) =>
      side === "start"
        ? {
            itemId: member.itemId,
            rowIndex: member.rowIndex,
            start: member.start + clean,
            duration: member.duration - clean,
            in: member.in === null ? null : member.in + clean,
          }
        : {
            itemId: member.itemId,
            rowIndex: member.rowIndex,
            start: member.start,
            duration: member.duration + clean,
            in: member.in,
          },
    ),
  };
}
