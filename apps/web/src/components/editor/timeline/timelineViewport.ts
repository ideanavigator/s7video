// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Pure viewport maths for the timeline (S7V-033): frames to pixels, zoom limits and anchoring,
 * and the bucketed window of mounted clips. Pixels are derived from integer frames at render time;
 * "lane" coordinates start at frame 0, to the right of the track labels.
 */

/** Chrome's layout units overflow near 33.5 million px; stay well under it on 3-hour edits. */
const MAX_CONTENT_PX = 16_000_000;
/** Fully zoomed in shows this many frames across the lanes. */
const FRAMES_PER_SCREEN_AT_MAX_ZOOM = 8;
const MIN_BUCKET_PX = 128;
/** Buckets mounted beyond the screen on each side. */
const MARGIN_BUCKETS = 2;
/** Room after the last frame, so the end of the edit is not pinned to the right edge. */
const TAIL_SCREEN_FRACTION = 0.25;
/** An empty edit still gets a ruler: one minute at 30 fps. */
const EMPTY_EDIT_FRAMES = 1_800;

export interface ZoomLimits {
  /** The whole edit fits the lanes. */
  readonly min: number;
  /** A few frames fill the lanes. */
  readonly max: number;
}

export function zoomLimits(durationFrames: number, laneWidthPx: number): ZoomLimits {
  const frames = Math.max(1, durationFrames > 0 ? durationFrames : EMPTY_EDIT_FRAMES);
  const width = Math.max(1, laneWidthPx);
  const min = width / frames;
  const max = Math.max(
    min,
    Math.min(width / FRAMES_PER_SCREEN_AT_MAX_ZOOM, MAX_CONTENT_PX / frames),
  );
  return { min, max };
}

export const clampZoom = (pxPerFrame: number, limits: ZoomLimits): number =>
  Math.min(limits.max, Math.max(limits.min, pxPerFrame));

export const frameToPx = (frame: number, pxPerFrame: number): number => frame * pxPerFrame;

/** The frame whose span holds lane pixel `x`, clamped to `[0, lastFrame]`. */
export function frameAtPx(x: number, pxPerFrame: number, lastFrame: number): number {
  const frame = Math.floor(x / pxPerFrame + 1e-9);
  return Math.max(0, Math.min(Math.max(0, lastFrame), frame));
}

export function contentWidthPx(durationFrames: number, pxPerFrame: number, laneWidthPx: number) {
  const frames = durationFrames > 0 ? durationFrames : EMPTY_EDIT_FRAMES;
  return Math.ceil(frames * pxPerFrame + laneWidthPx * TAIL_SCREEN_FRACTION);
}

export interface ZoomResult {
  readonly pxPerFrame: number;
  readonly scrollLeft: number;
}

/**
 * Zooms to `nextPxPerFrame` keeping the point under `anchorX` (lane pixels from the left edge of
 * the visible lanes) fixed on screen. The scroll position is not clamped to the content here, so
 * the anchor holds exactly; the browser clamps it at the ends.
 */
export function zoomAround(
  scrollLeft: number,
  pxPerFrame: number,
  nextPxPerFrame: number,
  anchorX: number,
): ZoomResult {
  const frame = (scrollLeft + anchorX) / pxPerFrame;
  return { pxPerFrame: nextPxPerFrame, scrollLeft: Math.max(0, frame * nextPxPerFrame - anchorX) };
}

/** A ctrl/cmd + wheel or pinch delta (pixels) as a zoom factor; pinches send small deltas. */
export const zoomFactorOfWheel = (deltaY: number): number => Math.exp(-deltaY * 0.003);

export const bucketWidthPx = (laneWidthPx: number): number =>
  Math.max(MIN_BUCKET_PX, Math.floor(laneWidthPx / 4));

export const bucketOf = (scrollLeft: number, bucketPx: number): number =>
  Math.max(0, Math.floor(scrollLeft / bucketPx));

export interface VisibleWindow {
  readonly startPx: number;
  readonly endPx: number;
  readonly startFrame: number;
  readonly endFrame: number;
}

/**
 * The lane pixels whose clips are mounted while the scroll position is inside `bucket`: the
 * screen plus two quarter-screen buckets on either side. React renders only when scrolling
 * crosses a bucket, and each crossing mounts a quarter screen of clips, which keeps commits short.
 */
export function visibleWindow(
  bucket: number,
  bucketPx: number,
  laneWidthPx: number,
  pxPerFrame: number,
): VisibleWindow {
  const startPx = Math.max(0, (bucket - MARGIN_BUCKETS) * bucketPx);
  const endPx = (bucket + 1 + MARGIN_BUCKETS) * bucketPx + laneWidthPx;
  return {
    startPx,
    endPx,
    startFrame: Math.floor(startPx / pxPerFrame),
    endFrame: Math.ceil(endPx / pxPerFrame),
  };
}
