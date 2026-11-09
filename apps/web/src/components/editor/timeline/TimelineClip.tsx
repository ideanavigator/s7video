// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * One mounted clip block (S7V-033): label and track colour, positioned in lane pixels from its
 * integer frames. The media layer is a flat placeholder until S7V-035 draws waveform peaks and
 * filmstrip tiles into it; the clip never waits for media data to render.
 */
import type {
  EditRational,
  EditTrackKind,
  EnvironmentId,
  MediaAsset,
  ProjectId,
} from "@t3tools/contracts";
import { memo } from "react";

import { ClipMediaSlot } from "./ClipMediaSlot";
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
  readonly fps: EditRational;
  /** Present when the timeline knows the project and the item shows project media. */
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly asset?: MediaAsset | undefined;
  /** Selected, or linked to a selected clip (S7V-034). */
  readonly selected?: boolean;
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
      data-selected={props.selected === true}
      data-readonly={kind === "caption" || undefined}
      className="@container absolute top-0 cursor-grab data-[readonly=true]:cursor-default data-[edge-hover=true]:cursor-ew-resize touch-none overflow-hidden rounded-sm border px-1 text-3xs leading-4 whitespace-nowrap text-foreground [contain:strict] data-[blocked=true]:outline-2 data-[blocked=true]:-outline-offset-2 data-[blocked=true]:outline-destructive data-[editing=true]:opacity-40 data-[selected=true]:ring-2 data-[selected=true]:ring-primary data-[selected=true]:ring-inset"
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
      {props.environmentId !== undefined &&
      props.projectId !== undefined &&
      props.asset !== undefined ? (
        <ClipMediaSlot
          environmentId={props.environmentId}
          projectId={props.projectId}
          item={item}
          kind={kind}
          asset={props.asset}
          fps={props.fps}
          heightPx={props.heightPx}
        />
      ) : null}
      {/* Trim handles on the selected clip only, so 1,000 clips add no elements (S7V-034), and
          hidden under 18 px, where a press moves the clip. Any clip's edge trims and shows a
          resize cursor (`timelineEditor.ts`). */}
      {props.selected === true ? (
        <>
          <span
            aria-hidden
            data-trim-handle="start"
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize bg-foreground/40 @max-[18px]:hidden"
          />
          <span
            aria-hidden
            data-trim-handle="end"
            className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize bg-foreground/40 @max-[18px]:hidden"
          />
        </>
      ) : null}
    </div>
  );
}

/** Memoized: a bucket crossing re-renders the lane, and most of its clips are unchanged. */
export const TimelineClip = memo(TimelineClipBlock);
