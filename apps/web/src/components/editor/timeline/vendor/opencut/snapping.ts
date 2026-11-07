// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), files apps/web/src/timeline/snapping/{types,resolve,threshold}.ts. Copied for S7V-033 from the spike B1 copies.
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
 * s7video changes: MediaTime ticks -> integer frames; three files merged; the threshold takes pixels per frame.
 */

export type SnapPointType = "element-start" | "element-end" | "playhead" | "bookmark" | "keyframe";

export interface SnapPoint {
  time: number;
  type: SnapPointType;
  elementId?: string;
  trackId?: string;
}

export interface SnapResult {
  snappedTime: number;
  snapPoint: SnapPoint | null;
  snapDistance: number;
}

export type TimelineSnapPointSource = () => Iterable<SnapPoint>;

export function resolveTimelineSnap({
  targetTime,
  snapPoints,
  maxSnapDistance,
}: {
  targetTime: number;
  snapPoints: SnapPoint[];
  maxSnapDistance: number;
}): SnapResult {
  let closestSnapPoint: SnapPoint | null = null;
  let closestDistance = Infinity;

  for (const snapPoint of snapPoints) {
    const distance = Math.abs(targetTime - snapPoint.time);
    if (distance <= maxSnapDistance && distance < closestDistance) {
      closestDistance = distance;
      closestSnapPoint = snapPoint;
    }
  }

  return {
    snappedTime: closestSnapPoint ? closestSnapPoint.time : targetTime,
    snapPoint: closestSnapPoint,
    snapDistance: closestDistance,
  };
}

const DEFAULT_TIMELINE_SNAP_THRESHOLD_PX = 10;

export function getTimelineSnapThresholdInFrames({
  pixelsPerFrame,
  snapThresholdPx = DEFAULT_TIMELINE_SNAP_THRESHOLD_PX,
}: {
  pixelsPerFrame: number;
  snapThresholdPx?: number;
}): number {
  return snapThresholdPx / pixelsPerFrame;
}
