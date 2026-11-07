// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * One track lane (S7V-033): the clips inside the visible window are mounted; clips under 4 px
 * (`lod.ts`) are drawn into one canvas strip for the lane instead.
 */
import type { EditRational } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { formatPlaybackClock } from "../../../editor/editPlayback";
import { drawClipStrip } from "./ClipCanvasStrip";
import { splitByDetail } from "./lod";
import { firstItemEndingAfter, type TimelineRow } from "./timelineModel";
import type { VisibleWindow } from "./timelineViewport";
import { TimelineClip } from "./TimelineClip";
import { TIMELINE_TRACK_COLOR_VARIABLE, TIMELINE_TRACK_HEIGHTS_PX } from "./vendor/opencut/theme";

export function TimelineTrack(props: {
  readonly row: TimelineRow;
  readonly fps: EditRational;
  readonly pxPerFrame: number;
  readonly detailScale: number;
  readonly window: VisibleWindow;
  /** The lanes' full width, so the strip never runs past the content. */
  readonly contentWidthPx: number;
}) {
  const { row, pxPerFrame, window } = props;
  const height = TIMELINE_TRACK_HEIGHTS_PX[row.kind];
  const from = firstItemEndingAfter(row.items, window.startFrame);
  const split = splitByDetail(row.items, from, window.endFrame, props.detailScale);
  const stripStart = window.startPx;
  const stripWidth = Math.max(1, Math.min(window.endPx, props.contentWidthPx) - stripStart);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorVariable = TIMELINE_TRACK_COLOR_VARIABLE[row.kind];
  const strip = split.strip;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the canvas, which React cannot render; runs only when the window, zoom or clips change
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    drawClipStrip(canvas, {
      items: strip,
      pxPerFrame,
      startPx: stripStart,
      widthPx: stripWidth,
      heightPx: height,
      color: getComputedStyle(canvas).getPropertyValue(colorVariable).trim() || "currentColor",
      devicePixelRatio: globalThis.devicePixelRatio,
    });
  }, [canvasRef, strip, pxPerFrame, stripStart, stripWidth, height, colorVariable]);

  return (
    <div
      role="list"
      aria-label={`${row.label} track, ${row.items.length} ${row.items.length === 1 ? "clip" : "clips"}`}
      data-timeline-row={row.kind}
      data-track-id={row.id}
      className="relative [contain:layout_style]"
      style={{ height }}
    >
      {strip.length > 0 ? (
        <canvas
          ref={canvasRef}
          aria-hidden
          data-lod-clips={strip.length}
          className="pointer-events-none absolute top-0"
          style={{ left: stripStart, width: stripWidth, height }}
        />
      ) : null}
      {split.mounted.map((index) => {
        const item = row.items[index]!;
        return (
          <TimelineClip
            key={item.id}
            item={item}
            kind={row.kind}
            pxPerFrame={pxPerFrame}
            heightPx={height}
            spokenStart={formatPlaybackClock(item.start, props.fps)}
          />
        );
      })}
    </div>
  );
}
