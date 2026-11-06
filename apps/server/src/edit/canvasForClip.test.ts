// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditMediaProbe } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CANVAS_FOR_RATIO, canvasForClip } from "./canvasForClip.ts";

const clip = (width: number, height: number): EditMediaProbe => ({
  hasVideo: true,
  hasAudio: true,
  width,
  height,
});

describe("canvasForClip", () => {
  it("keeps the clip's shape, with the long side at most 1920", () => {
    expect(canvasForClip(clip(1894, 1080))).toEqual({ width: 1894, height: 1080 });
    expect(canvasForClip(clip(3840, 2160))).toEqual({ width: 1920, height: 1080 });
    expect(canvasForClip(clip(1080, 1920))).toEqual({ width: 1080, height: 1920 });
    expect(canvasForClip(clip(2160, 3840))).toEqual({ width: 1080, height: 1920 });
    expect(canvasForClip(clip(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("rounds both sides to even, as the encoder needs", () => {
    expect(canvasForClip(clip(1001, 563))).toEqual({ width: 1002, height: 564 });
    const scaled = canvasForClip(clip(4001, 2251))!;
    expect(scaled.width % 2).toBe(0);
    expect(scaled.height % 2).toBe(0);
    expect(scaled.width).toBeLessThanOrEqual(1920);
  });

  it("gives no canvas for a clip with no picture size", () => {
    expect(canvasForClip({ hasVideo: false, hasAudio: true })).toBeUndefined();
    expect(canvasForClip({ hasVideo: true, hasAudio: true })).toBeUndefined();
  });

  it("names a canvas for each common aspect ratio", () => {
    expect(CANVAS_FOR_RATIO).toEqual({
      "9:16": { width: 1080, height: 1920 },
      "16:9": { width: 1920, height: 1080 },
      "1:1": { width: 1080, height: 1080 },
      "4:5": { width: 1080, height: 1350 },
      "4:3": { width: 1440, height: 1080 },
    });
  });
});
