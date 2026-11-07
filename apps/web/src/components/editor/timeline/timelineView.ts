// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The timeline's live view (S7V-033) for code that draws inside clips, such as S7V-035's
 * waveforms and filmstrips: what is on screen right now, published by the controller on every
 * scroll event and zoom step, outside React. A clip that needs pixel sizes subscribes here
 * instead of taking them as props, so zooming never re-renders every clip.
 */
import { createContext } from "react";

import type { TimelineItem } from "./timelineModel";

export interface TimelineView {
  /** Lane pixels per frame now (React may have rendered an older zoom). */
  readonly pxPerFrame: number;
  /** Edit frames on screen, `[startFrame, endFrame)`, fractional at the edges. */
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface TimelineViewSource {
  readonly getView: () => TimelineView;
  /** Called on every change, synchronously from the scroll or zoom that caused it. */
  readonly subscribeView: (listener: (view: TimelineView) => void) => () => void;
}

/** Provided by `Timeline`; null outside a timeline (a clip rendered in isolation). */
export const TimelineViewContext = createContext<TimelineViewSource | null>(null);

export interface ClipSpan {
  /** Edit frames of the clip on screen, `[firstFrame, endFrame)`; empty when off screen. */
  readonly firstFrame: number;
  readonly endFrame: number;
  /** The same in the clip's source media (adds the item's `in`). */
  readonly sourceFirstFrame: number;
  readonly sourceEndFrame: number;
  /** Where the visible part starts inside the clip block, and how wide it is, in CSS pixels. */
  readonly offsetPx: number;
  readonly widthPx: number;
}

/** The part of `item` the view shows: what a waveform or filmstrip canvas covers. */
export function clipSpanInView(item: TimelineItem, view: TimelineView): ClipSpan {
  const first = Math.max(item.start, Math.floor(view.startFrame));
  const end = Math.max(first, Math.min(item.start + item.duration, Math.ceil(view.endFrame)));
  return {
    firstFrame: first,
    endFrame: end,
    sourceFirstFrame: item.in + (first - item.start),
    sourceEndFrame: item.in + (end - item.start),
    offsetPx: (first - item.start) * view.pxPerFrame,
    widthPx: (end - first) * view.pxPerFrame,
  };
}
