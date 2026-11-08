// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * One track lane (S7V-033): the clips inside the visible window are mounted; clips under 4 px
 * (`lod.ts`) are drawn into one canvas strip for the lane instead.
 */
import type { EditRational, EnvironmentId, MediaAsset, ProjectId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { formatPlaybackClock } from "../../../editor/editPlayback";
import { drawClipStrip } from "./ClipCanvasStrip";
import { SPAN_ATTRIBUTE, spanX } from "./laneGeometry";
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
  readonly durationFrames: number;
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | undefined;
  /** The project's media library by id, for each clip's media slot. */
  readonly mediaById?: ReadonlyMap<string, MediaAsset> | undefined;
  /** Selected clips and their linked items (S7V-034). */
  readonly highlighted?: ReadonlySet<string>;
}) {
  const { row, pxPerFrame, window } = props;
  const height = TIMELINE_TRACK_HEIGHTS_PX[row.kind];
  const from = firstItemEndingAfter(row.items, window.startFrame);
  const split = splitByDetail(row.items, from, window.endFrame, props.detailScale);
  // The strip covers the window's frames, drawn at the zoom React rendered; between renders the
  // span stretches it with the zoom, which is exact for flat blocks.
  const stripStartFrame = window.startFrame;
  const stripFrames = Math.max(1, window.endFrame - window.startFrame);
  const stripStart = stripStartFrame * pxPerFrame;
  const stripWidth = stripFrames * pxPerFrame;
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
      data-window-start={window.startFrame}
      data-window-end={window.endFrame}
      {...{ [SPAN_ATTRIBUTE]: "" }}
      className="relative [contain:layout_style]"
      style={{ height }}
    >
      {strip.length > 0 ? (
        <canvas
          ref={canvasRef}
          aria-hidden
          data-lod-clips={strip.length}
          className="pointer-events-none absolute top-0"
          style={{
            left: spanX(stripStartFrame, props.durationFrames),
            width: spanX(stripFrames, props.durationFrames),
            height,
          }}
        />
      ) : null}
      {split.mounted.map((index) => {
        const item = row.items[index]!;
        return (
          <TimelineClip
            key={item.id}
            item={item}
            kind={row.kind}
            durationFrames={props.durationFrames}
            heightPx={height}
            spokenStart={formatPlaybackClock(item.start, props.fps)}
            fps={props.fps}
            environmentId={props.environmentId}
            projectId={props.projectId}
            asset={item.mediaId === null ? undefined : props.mediaById?.get(item.mediaId)}
            selected={props.highlighted?.has(item.id) === true}
          />
        );
      })}
    </div>
  );
}
