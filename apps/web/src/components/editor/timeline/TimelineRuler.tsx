// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The ruler (S7V-033): ticks and labels for the visible window only. It is the playhead's slider
 * for assistive tech; the controller writes `aria-valuenow` and the timecode `aria-valuetext`
 * as the playhead moves, so React never renders per frame.
 */
import type { EditRational } from "@t3tools/contracts";

import { SPAN_ATTRIBUTE, spanX } from "./laneGeometry";
import { rulerTicks } from "./rulerTicks";
import type { VisibleWindow } from "./timelineViewport";
import { TIMELINE_RULER_HEIGHT_PX } from "./vendor/opencut/theme";

export function TimelineRuler(props: {
  readonly fps: EditRational;
  readonly pxPerFrame: number;
  readonly window: VisibleWindow;
  readonly durationFrames: number;
  readonly attachSlider: (element: HTMLDivElement | null) => void;
}) {
  const { fps, pxPerFrame, window: visible, durationFrames, attachSlider } = props;
  const ticks = rulerTicks({
    startPx: visible.startPx,
    endPx: visible.endPx,
    pxPerFrame,
    fps,
    endFrame: visible.endFrame,
  });
  return (
    <div
      ref={attachSlider}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-orientation="horizontal"
      data-timeline-ruler
      {...{ [SPAN_ATTRIBUTE]: "" }}
      className="relative shrink-0 cursor-pointer border-b outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      style={{ height: TIMELINE_RULER_HEIGHT_PX }}
    >
      {ticks.map((tick) =>
        tick.label === undefined ? (
          <div
            key={tick.frame}
            aria-hidden
            className="absolute top-[14px] h-1.5 border-l border-muted-foreground/50"
            style={{ left: spanX(tick.frame, durationFrames) }}
          />
        ) : (
          <div
            key={tick.frame}
            aria-hidden
            className="absolute top-0 h-full border-l border-muted-foreground/60 pl-1 text-3xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums"
            style={{ left: spanX(tick.frame, durationFrames) }}
          >
            {tick.label}
          </div>
        ),
      )}
    </div>
  );
}
