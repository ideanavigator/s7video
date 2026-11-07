// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import {
  bucketOf,
  bucketWidthPx,
  clampZoom,
  contentWidthPx,
  frameAtPx,
  frameToPx,
  visibleWindow,
  zoomAround,
  zoomLimits,
} from "./timelineViewport";

const ZOOMS = [0.05, 0.18, 1, 2.5, 7, 60, 125];

describe("timelineViewport", () => {
  it("maps frames to pixels and back exactly at every zoom", () => {
    for (const pxPerFrame of ZOOMS) {
      for (const frame of [0, 1, 29, 30, 5_399, 323_999]) {
        expect(frameAtPx(frameToPx(frame, pxPerFrame), pxPerFrame, 400_000)).toBe(frame);
        // Anywhere inside the frame's span lands on that frame.
        expect(frameAtPx(frameToPx(frame + 0.999, pxPerFrame), pxPerFrame, 400_000)).toBe(frame);
      }
    }
  });

  it("clamps a pixel to the edit's frames", () => {
    expect(frameAtPx(-5, 2, 100)).toBe(0);
    expect(frameAtPx(10_000, 2, 100)).toBe(100);
  });

  it("zooms from the whole edit to a few frames per screen", () => {
    const limits = zoomLimits(5_400, 1_000);
    expect(5_400 * limits.min).toBeCloseTo(1_000);
    expect(1_000 / limits.max).toBe(8);
    expect(clampZoom(1e9, limits)).toBe(limits.max);
    expect(clampZoom(0, limits)).toBe(limits.min);
  });

  it("keeps a 3-hour edit inside the browser's layout range", () => {
    const frames = 3 * 3600 * 30;
    const limits = zoomLimits(frames, 1_000);
    expect(contentWidthPx(frames, limits.max, 1_000)).toBeLessThan(17_000_000);
    expect(frameAtPx(frameToPx(frames - 1, limits.max), limits.max, frames - 1)).toBe(frames - 1);
  });

  it("keeps the frame under the cursor fixed while zooming", () => {
    for (const [scrollLeft, from, to, anchor] of [
      [500, 2, 3.1, 240],
      [0, 0.2, 40, 10],
      [12_345, 7, 0.4, 999],
    ] as const) {
      const before = (scrollLeft + anchor) / from;
      const next = zoomAround(scrollLeft, from, to, anchor);
      const after = (next.scrollLeft + anchor) / next.pxPerFrame;
      if (next.scrollLeft > 0) expect(Math.abs(after - before) * to).toBeLessThan(1e-6);
    }
  });

  it("mounts the screen plus one bucket either side", () => {
    const lane = 1_000;
    const bucketPx = bucketWidthPx(lane);
    expect(bucketPx).toBe(500);
    const scrollLeft = 2_600;
    const bucket = bucketOf(scrollLeft, bucketPx);
    expect(bucket).toBe(5);
    const window = visibleWindow(bucket, bucketPx, lane, 2);
    expect(window.startPx).toBe(2_000);
    expect(window.startPx).toBeLessThanOrEqual(scrollLeft - (scrollLeft % bucketPx) - bucketPx);
    expect(window.endPx).toBeGreaterThanOrEqual(scrollLeft + lane + bucketPx);
    expect(window.startFrame).toBe(1_000);
    expect(visibleWindow(0, bucketPx, lane, 2).startPx).toBe(0);
  });
});
