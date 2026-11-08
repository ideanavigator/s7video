// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), file apps/web/src/timeline/controllers/element-interaction-controller.ts. Ported for S7V-034 from the spike B1 copies.
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
 * s7video changes: MediaTime ticks -> integer frames from the live px-per-frame; pointer events on the document instead of React mouse events; no drop targets or new tracks (a clip moves along its row or to another row of the same kind); cmd turns snapping off; the release commits one move gesture (one edit.apply batch, S7V-034), or a refused move returns with a blocked state.
 */

import { getTimelineSnapThresholdInFrames, type SnapPoint } from "../vendor/opencut/snapping";
import type { TimelineRow } from "../timelineModel";
import {
  buildMoveGroup,
  buildSnapPoints,
  resolveGroupMove,
  snapGroupEdges,
  type GroupMoveResult,
  type MoveGroup,
} from "./groupMove";
import { SNAP_DISTANCE_PX } from "./resizeController";

/** OpenCut's TIMELINE_DRAG_THRESHOLD_PX: a press that moves less than this is a click. */
const DRAG_THRESHOLD_PX = 3;

export interface MoveGesture {
  readonly kind: "move";
  readonly delta: number;
  /** Every member, linked items included. */
  readonly itemIds: ReadonlyArray<string>;
  /** The row the group moves to, when it is one row and that row changes. */
  readonly toRowId: string | null;
}

export interface ElementInteractionConfig {
  readonly getRows: () => ReadonlyArray<TimelineRow>;
  readonly getSelected: () => ReadonlySet<string>;
  readonly select: (itemId: string, mode: "only" | "toggle" | "keep") => void;
  readonly pxPerFrame: () => number;
  readonly playheadFrame: () => number;
  /** The row under a viewport y, or -1 above or below the rows. */
  readonly rowIndexAtClientY: (clientY: number) => number;
  readonly previewMove: (result: GroupMoveResult, snapFrame: number | null) => void;
  readonly discardPreview: () => void;
  readonly commitMove: (gesture: MoveGesture) => void;
  /** A refused move: the clip went back, and the block shows why for a moment. */
  readonly refuseMove: (itemIds: ReadonlyArray<string>, result: GroupMoveResult) => void;
}

interface PointerDownSnapshot {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly itemId: string;
  readonly shift: boolean;
  readonly wasSelected: boolean;
}

interface DragProgress {
  readonly group: MoveGroup;
  readonly snapPoints: SnapPoint[];
  result: GroupMoveResult | null;
}

type Session =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly down: PointerDownSnapshot }
  | { readonly kind: "dragging"; readonly down: PointerDownSnapshot; readonly drag: DragProgress };

export class ElementInteractionController {
  private session: Session = { kind: "idle" };
  private readonly config: ElementInteractionConfig;

  constructor(config: ElementInteractionConfig) {
    this.config = config;
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  get isDragging(): boolean {
    return this.session.kind === "dragging";
  }

  cancel(): void {
    if (this.session.kind === "idle") return;
    this.config.discardPreview();
    this.finishSession();
  }

  destroy(): void {
    this.deactivate();
    this.session = { kind: "idle" };
  }

  onPointerDown(input: {
    readonly pointerId: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly itemId: string;
    readonly shift: boolean;
  }): void {
    if (this.session.kind !== "idle") this.cancel();
    const wasSelected = this.config.getSelected().has(input.itemId);
    // Pressing an unselected clip selects it at once, so dragging it moves it (and only it).
    if (!wasSelected) this.config.select(input.itemId, input.shift ? "toggle" : "only");
    this.session = {
      kind: "pending",
      down: {
        pointerId: input.pointerId,
        x: input.clientX,
        y: input.clientY,
        itemId: input.itemId,
        shift: input.shift,
        wasSelected,
      },
    };
    this.activate();
  }

  private activate(): void {
    document.addEventListener("pointermove", this.handlePointerMove);
    document.addEventListener("pointerup", this.handlePointerUp);
    document.addEventListener("pointercancel", this.handlePointerUp);
  }

  private deactivate(): void {
    document.removeEventListener("pointermove", this.handlePointerMove);
    document.removeEventListener("pointerup", this.handlePointerUp);
    document.removeEventListener("pointercancel", this.handlePointerUp);
  }

  private finishSession(): void {
    this.session = { kind: "idle" };
    this.deactivate();
  }

  private beginDrag(down: PointerDownSnapshot): DragProgress | null {
    const rows = this.config.getRows();
    const group = buildMoveGroup(rows, down.itemId, this.config.getSelected());
    if (group === null) return null;
    const exclude = new Set(group.members.map((member) => member.itemId));
    return {
      group,
      snapPoints: buildSnapPoints(rows, exclude, this.config.playheadFrame()),
      result: null,
    };
  }

  private handlePointerMove(event: PointerEvent): void {
    const session = this.session;
    if (session.kind === "idle" || event.pointerId !== session.down.pointerId) return;
    let drag: DragProgress;
    if (session.kind === "pending") {
      const moved =
        Math.abs(event.clientX - session.down.x) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - session.down.y) > DRAG_THRESHOLD_PX;
      if (!moved) return;
      const started = this.beginDrag(session.down);
      if (started === null) {
        this.finishSession();
        return;
      }
      drag = started;
      this.session = { kind: "dragging", down: session.down, drag };
    } else {
      drag = session.drag;
    }
    const pxPerFrame = this.config.pxPerFrame();
    const rawAnchor =
      drag.group.anchor.start + Math.round((event.clientX - session.down.x) / pxPerFrame);
    let anchorStart = rawAnchor;
    let snapFrame: number | null = null;
    if (!event.metaKey) {
      const snapped = snapGroupEdges(
        drag.group,
        rawAnchor,
        drag.snapPoints,
        getTimelineSnapThresholdInFrames({
          pixelsPerFrame: pxPerFrame,
          snapThresholdPx: SNAP_DISTANCE_PX,
        }),
      );
      anchorStart = snapped.anchorStart;
      snapFrame = snapped.snapPoint?.time ?? null;
    }
    const rowIndex = this.config.rowIndexAtClientY(event.clientY);
    const result = resolveGroupMove(
      drag.group,
      this.config.getRows(),
      anchorStart,
      rowIndex < 0 ? drag.group.anchor.rowIndex : rowIndex,
    );
    drag.result = result;
    // A clamp at frame 0 moves the group off the snapped edge; then no line.
    const landed = result.moves.find((move) => move.itemId === drag.group.anchor.itemId)!.start;
    this.config.previewMove(result, landed === anchorStart ? snapFrame : null);
  }

  private handlePointerUp(event: PointerEvent): void {
    const session = this.session;
    if (session.kind === "idle" || event.pointerId !== session.down.pointerId) return;
    this.finishSession();
    if (session.kind === "pending") {
      // A click: shift toggles a clip that was already selected; a plain click keeps only it.
      if (session.down.wasSelected) {
        this.config.select(session.down.itemId, session.down.shift ? "toggle" : "only");
      }
      return;
    }
    const { group, result } = session.drag;
    const itemIds = group.members.map((member) => member.itemId);
    if (event.type === "pointercancel" || result === null) {
      this.config.discardPreview();
      return;
    }
    if (result.refused !== null) {
      this.config.discardPreview();
      this.config.refuseMove(itemIds, result);
      return;
    }
    const anchorMove = result.moves.find((move) => move.itemId === group.anchor.itemId)!;
    const delta = anchorMove.start - group.anchor.start;
    const rowChanged = anchorMove.toRowIndex !== group.anchor.rowIndex;
    if (delta === 0 && !rowChanged) {
      this.config.discardPreview();
      return;
    }
    this.config.commitMove({
      kind: "move",
      delta,
      itemIds,
      toRowId: rowChanged ? (this.config.getRows()[anchorMove.toRowIndex]?.id ?? null) : null,
    });
  }
}
