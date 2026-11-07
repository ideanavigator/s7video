// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Level of detail (S7V-033, spike B1): clips narrower than 4 px are not mounted; they are drawn
 * into one canvas strip per track, so mounted DOM is bounded by screen pixels, not clip count.
 * The decision uses a lagging "detail scale" that moves only when the zoom changes by more than
 * a fifth, so a small zoom back and forth near the threshold does not swap clips in and out.
 */
import type { TimelineItem } from "./timelineModel";

export const LOD_MIN_CLIP_PX = 4;
const DETAIL_SCALE_STEP = 1.2;

/** The scale LOD decides at: the previous one, unless the zoom moved past the hysteresis band. */
export function nextDetailScale(previous: number | null, pxPerFrame: number): number {
  if (previous === null || previous <= 0) return pxPerFrame;
  const ratio = pxPerFrame / previous;
  return ratio > DETAIL_SCALE_STEP || ratio < 1 / DETAIL_SCALE_STEP ? pxPerFrame : previous;
}

/** Whether a clip of `durationFrames` is mounted as a DOM block at detail scale `detailScale`. */
export const isMountedClip = (durationFrames: number, detailScale: number): boolean =>
  durationFrames * detailScale >= LOD_MIN_CLIP_PX;

export interface LodSplit {
  /** Indexes into the row's items, mounted as `TimelineClip`. */
  readonly mounted: ReadonlyArray<number>;
  /** Items drawn into the row's canvas strip. */
  readonly strip: ReadonlyArray<TimelineItem>;
}

/** Splits the row's items `[from, …)` that start before `endFrame`. */
export function splitByDetail(
  items: ReadonlyArray<TimelineItem>,
  from: number,
  endFrame: number,
  detailScale: number,
): LodSplit {
  const mounted: number[] = [];
  const strip: TimelineItem[] = [];
  for (let index = from; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.start >= endFrame) break;
    if (isMountedClip(item.duration, detailScale)) mounted.push(index);
    else strip.push(item);
  }
  return { mounted, strip };
}
