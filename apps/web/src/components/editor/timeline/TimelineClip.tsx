// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * One mounted clip block (S7V-033): label and track colour, positioned in lane pixels from its
 * integer frames. The media layer is a flat placeholder until S7V-035 draws waveform peaks and
 * filmstrip tiles into it; the clip never waits for media data to render.
 */
import type { EditTrackKind } from "@t3tools/contracts";

import type { TimelineItem } from "./timelineModel";
import { TIMELINE_TRACK_COLOR } from "./vendor/opencut/theme";

/** Below this width a label would only show an ellipsis. */
const MIN_LABEL_PX = 30;

export function TimelineClip(props: {
  readonly item: TimelineItem;
  readonly kind: EditTrackKind;
  readonly pxPerFrame: number;
  readonly heightPx: number;
  readonly spokenStart: string;
}) {
  const { item, kind, pxPerFrame } = props;
  const color = TIMELINE_TRACK_COLOR[kind];
  const width = Math.max(1, item.duration * pxPerFrame - 1);
  return (
    <div
      role="listitem"
      aria-label={`${item.label}, from ${props.spokenStart}`}
      data-timeline-item={item.id}
      data-start={item.start}
      data-duration={item.duration}
      className="absolute top-0 overflow-hidden rounded-sm border [contain:strict]"
      style={{
        left: item.start * pxPerFrame,
        width,
        height: props.heightPx,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 38%, var(--card))`,
      }}
    >
      <div
        aria-hidden
        data-clip-media={item.mediaId ?? undefined}
        data-media-in={item.in}
        className="absolute inset-0"
      />
      {width > MIN_LABEL_PX ? (
        <span className="pointer-events-none absolute top-0.5 left-1 max-w-[calc(100%-0.5rem)] truncate text-3xs leading-3 text-foreground">
          {item.label}
        </span>
      ) : null}
    </div>
  );
}
