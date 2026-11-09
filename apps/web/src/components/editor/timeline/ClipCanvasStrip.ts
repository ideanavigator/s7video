// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The canvas strip for clips under 4 px (S7V-033, `lod.ts`): one canvas per track, covering the
 * visible window, with every small clip filled in the track's colour. Drawn once per window or
 * zoom change, never per frame.
 */
import type { TimelineItem } from "./timelineModel";

export interface StripDrawing {
  readonly items: ReadonlyArray<TimelineItem>;
  readonly pxPerFrame: number;
  /** Lane pixel of the canvas's left edge. */
  readonly startPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** A resolved CSS colour; canvas cannot read `var(...)`. */
  readonly color: string;
  readonly devicePixelRatio: number;
}

/** The lane rectangles drawn for `items`, at least one pixel wide, a pixel gap between clips. */
function stripRects(
  drawing: Pick<StripDrawing, "items" | "pxPerFrame" | "startPx">,
): Array<{ readonly x: number; readonly width: number }> {
  return drawing.items.map((item) => ({
    x: item.start * drawing.pxPerFrame - drawing.startPx,
    width: Math.max(1, item.duration * drawing.pxPerFrame - 1),
  }));
}

export function drawClipStrip(canvas: HTMLCanvasElement, drawing: StripDrawing): void {
  const ratio = drawing.devicePixelRatio || 1;
  const width = Math.max(1, Math.ceil(drawing.widthPx * ratio));
  const height = Math.max(1, Math.ceil(drawing.heightPx * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, drawing.widthPx, drawing.heightPx);
  context.fillStyle = drawing.color;
  for (const rect of stripRects(drawing)) {
    context.fillRect(rect.x, 0, rect.width, drawing.heightPx);
  }
}
