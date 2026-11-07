// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), file apps/web/src/timeline/controllers/resize-controller.ts. Ported for S7V-034 from the spike B1 copies.
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
 * s7video changes: MediaTime ticks -> integer frames from the live px-per-frame; pointer events instead of React mouse events; cmd turns snapping off (shift in OpenCut); no keyframe snap points; the release commits one trim gesture (one edit.apply batch, S7V-034) instead of a store write; the snap point reported is the edge frame for the snap line.
 */

import {
  getTimelineSnapThresholdInFrames,
  resolveTimelineSnap,
  type SnapPoint,
} from "../vendor/opencut/snapping";
import type { TimelineRow } from "../timelineModel";
import { buildSnapPoints } from "./groupMove";
import {
  buildResizeMembers,
  computeGroupResize,
  type GroupResizeMember,
  type GroupResizeResult,
  type ResizeSide,
} from "./groupResize";

/** The snap distance on screen (S7V-034 AC-4). */
export const SNAP_DISTANCE_PX = 8;

export interface TrimGesture {
  readonly kind: "trim";
  readonly side: ResizeSide;
  readonly delta: number;
  /** Every member, linked items included. */
  readonly itemIds: ReadonlyArray<string>;
}

export interface ResizeConfig {
  readonly getRows: () => ReadonlyArray<TimelineRow>;
  readonly getSelected: () => ReadonlySet<string>;
  readonly pxPerFrame: () => number;
  readonly playheadFrame: () => number;
  readonly previewResize: (result: GroupResizeResult, snapFrame: number | null) => void;
  readonly discardPreview: () => void;
  readonly commitTrim: (gesture: TrimGesture) => void;
}

interface ResizeSession {
  readonly kind: "active";
  readonly pointerId: number;
  readonly side: ResizeSide;
  readonly startX: number;
  readonly members: ReadonlyArray<GroupResizeMember>;
  readonly snapPoints: SnapPoint[];
  result: GroupResizeResult | null;
}

type Session = { readonly kind: "idle" } | ResizeSession;

export class ResizeController {
  private session: Session = { kind: "idle" };
  private readonly config: ResizeConfig;

  constructor(config: ResizeConfig) {
    this.config = config;
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  get isResizing(): boolean {
    return this.session.kind === "active";
  }

  cancel(): void {
    if (this.session.kind !== "active") return;
    this.config.discardPreview();
    this.finishSession();
  }

  destroy(): void {
    this.deactivate();
    this.session = { kind: "idle" };
  }

  onResizeStart(input: {
    readonly pointerId: number;
    readonly clientX: number;
    readonly itemId: string;
    readonly side: ResizeSide;
  }): boolean {
    // A new resize start means the previous one is abandoned, not silently replaced.
    if (this.session.kind === "active") this.cancel();
    const rows = this.config.getRows();
    const members = buildResizeMembers(rows, input.itemId, this.config.getSelected());
    if (members.length === 0) return false;
    if (members.some((member) => rows[member.rowIndex]?.locked === true)) return false;
    const exclude = new Set(members.map((member) => member.itemId));
    this.config.discardPreview();
    this.session = {
      kind: "active",
      pointerId: input.pointerId,
      side: input.side,
      startX: input.clientX,
      members,
      snapPoints: buildSnapPoints(rows, exclude, this.config.playheadFrame()),
      result: null,
    };
    this.activate();
    return true;
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

  private snappedDelta(
    session: ResizeSession,
    rawDelta: number,
    snapping: boolean,
  ): { delta: number; snapFrame: number | null } {
    if (!snapping) return { delta: rawDelta, snapFrame: null };
    const maxSnapDistance = getTimelineSnapThresholdInFrames({
      pixelsPerFrame: this.config.pxPerFrame(),
      snapThresholdPx: SNAP_DISTANCE_PX,
    });
    let closestDistance = Infinity;
    let delta = rawDelta;
    let snapFrame: number | null = null;
    for (const member of session.members) {
      const edge = session.side === "start" ? member.start : member.start + member.duration;
      const snap = resolveTimelineSnap({
        targetTime: edge + rawDelta,
        snapPoints: session.snapPoints,
        maxSnapDistance,
      });
      if (snap.snapPoint && snap.snapDistance < closestDistance) {
        closestDistance = snap.snapDistance;
        delta = snap.snappedTime - edge;
        snapFrame = snap.snappedTime;
      }
    }
    return { delta, snapFrame };
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.session.kind !== "active" || event.pointerId !== this.session.pointerId) return;
    const session = this.session;
    const rawDelta = Math.round((event.clientX - session.startX) / this.config.pxPerFrame());
    const { delta, snapFrame } = this.snappedDelta(session, rawDelta, !event.metaKey);
    const result = computeGroupResize(session.members, session.side, delta);
    session.result = result;
    // The snap line shows only when the snapped edge is where the edge actually landed.
    this.config.previewResize(result, result.delta === delta ? snapFrame : null);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.session.kind !== "active" || event.pointerId !== this.session.pointerId) return;
    const session = this.session;
    this.finishSession();
    if (event.type === "pointercancel" || session.result === null || session.result.delta === 0) {
      this.config.discardPreview();
      return;
    }
    this.config.commitTrim({
      kind: "trim",
      side: session.side,
      delta: session.result.delta,
      itemIds: session.members.map((member) => member.itemId),
    });
  }
}
