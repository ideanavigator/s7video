// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { rulerTicks } from "./rulerTicks";
import { getTimelineSnapThresholdInFrames, resolveTimelineSnap } from "./vendor/opencut/snapping";

const FPS = { num: 30, den: 1 };
const labelsOf = (pxPerFrame: number, fps = FPS, endPx = 2_000) =>
  rulerTicks({ startPx: 0, endPx, pxPerFrame, fps, endFrame: 1e9 }).filter(
    (tick) => tick.label !== undefined,
  );

describe("rulerTicks", () => {
  it("spaces ticks and labels from the copied ruler-utils at each zoom", () => {
    // 60 px per frame: a label every 2 frames, a tick on every frame.
    const close = rulerTicks({ startPx: 0, endPx: 600, pxPerFrame: 60, fps: FPS, endFrame: 1e9 });
    expect(close.slice(0, 3)).toEqual([
      { x: 0, label: "00:00" },
      { x: 60 },
      { x: 120, label: "2f" },
    ]);
    // 2 px per frame (60 px/s): labels every 2 s, ticks every second.
    expect(
      labelsOf(2)
        .map((tick) => tick.label)
        .slice(0, 3),
    ).toEqual(["00:00", "00:02", "00:04"]);
    // Whole edit in view: labels minutes apart.
    expect(
      labelsOf(0.05, FPS, 10_000)
        .map((tick) => tick.label)
        .slice(0, 2),
    ).toEqual(["00:00", "02:00"]);
  });

  it("keeps labels at least 120 px apart at every zoom", () => {
    for (const pxPerFrame of [0.05, 0.3, 1, 4, 13, 40, 125]) {
      const labels = labelsOf(pxPerFrame);
      for (let index = 1; index < labels.length; index++) {
        expect(labels[index]!.x - labels[index - 1]!.x).toBeGreaterThanOrEqual(119.99);
      }
    }
  });

  it("labels 29.97 on drop-frame frame numbers", () => {
    const ntsc = { num: 30_000, den: 1_001 };
    const labels = rulerTicks({
      startPx: 1_799 * 60,
      endPx: 1_805 * 60,
      pxPerFrame: 60,
      fps: ntsc,
      endFrame: 1e9,
    }).filter((tick) => tick.label !== undefined);
    // Frame 1,800 is 00:01:00;02: frame numbers 0 and 1 are dropped at the minute.
    expect(labels.map((tick) => [tick.x / 60, tick.label])).toEqual([
      [1_800, "2f"],
      [1_802, "4f"],
      [1_804, "6f"],
    ]);
  });
});

describe("vendored OpenCut snapping", () => {
  it("snaps to the nearest point inside the threshold, in frames", () => {
    expect(getTimelineSnapThresholdInFrames({ pixelsPerFrame: 2 })).toBe(5);
    const points = [
      { time: 100, type: "playhead" as const },
      { time: 108, type: "element-start" as const },
    ];
    expect(
      resolveTimelineSnap({ targetTime: 104, snapPoints: points, maxSnapDistance: 5 }),
    ).toMatchObject({ snappedTime: 100, snapDistance: 4 });
    expect(
      resolveTimelineSnap({ targetTime: 120, snapPoints: points, maxSnapDistance: 5 }).snapPoint,
    ).toBeNull();
  });
});
