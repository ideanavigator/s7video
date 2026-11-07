// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * One mounted clip block (S7V-033): label and track colour, positioned in lane pixels from its
 * integer frames. The media layer is a flat placeholder until S7V-035 draws waveform peaks and
 * filmstrip tiles into it; the clip never waits for media data to render.
 */
import type { EditTrackKind } from "@t3tools/contracts";
import { memo } from "react";

import { spanWidth, spanX } from "./laneGeometry";
import type { TimelineItem } from "./timelineModel";
import { TIMELINE_TRACK_COLOR } from "./vendor/opencut/theme";

function TimelineClipBlock(props: {
  readonly item: TimelineItem;
  readonly kind: EditTrackKind;
  /** The edit's length, which positions are a percentage of. */
  readonly durationFrames: number;
  readonly heightPx: number;
  readonly spokenStart: string;
}) {
  const { item, kind } = props;
  const color = TIMELINE_TRACK_COLOR[kind];
  return (
    <div
      role="listitem"
      aria-label={`${item.label}, from ${props.spokenStart}`}
      data-timeline-item={item.id}
      data-start={item.start}
      data-duration={item.duration}
      data-clip-media={item.mediaId ?? undefined}
      data-media-in={item.in}
      className="absolute top-0 overflow-hidden rounded-sm border px-1 text-3xs leading-4 whitespace-nowrap text-foreground [contain:strict]"
      style={{
        left: spanX(item.start, props.durationFrames),
        width: spanWidth(item.duration, props.durationFrames),
        height: props.heightPx,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 38%, var(--card))`,
      }}
    >
      {/* Text right in the block: one element per clip keeps style and layout work small. */}
      {item.label}
    </div>
  );
}

/** Memoized: a bucket crossing re-renders the lane, and most of its clips are unchanged. */
export const TimelineClip = memo(TimelineClipBlock);
