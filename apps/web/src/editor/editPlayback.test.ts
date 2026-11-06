// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clipPlaybackPlan,
  editPlaybackPlan,
  formatPlaybackClock,
  frameAtTime,
  sourceFrameOf,
  stepAfterFrame,
  timelineFrameOf,
  timeOfFrame,
} from "./editPlayback";

const FPS_30 = { num: 30, den: 1 };
const FPS_2997 = { num: 30_000, den: 1_001 };

const editOf = (
  items: ReadonlyArray<{ media?: string; start: number; duration: number; in: number }>,
  fps = FPS_30,
): EditDocument => ({
  version: 1,
  fps,
  canvas: { width: 1920, height: 1080 },
  media: [],
  tracks: [
    {
      kind: "video",
      id: "v1",
      items: items.map((item, index) => ({ id: `item-${index}`, media: "clip", ...item })),
    },
  ],
  markers: [],
  metadata: {},
});

/** Keep ranges as a silence cut writes them: back to back on the timeline, gaps in the source. */
const cutEdit = (ranges: ReadonlyArray<readonly [number, number]>, fps = FPS_30) => {
  let start = 0;
  return editOf(
    ranges.map(([from, to]) => {
      const item = { start, duration: to - from, in: from };
      start += to - from;
      return item;
    }),
    fps,
  );
};

describe("editPlayback builds segment map from keep ranges", () => {
  it("maps keep ranges to source segments in edit order", () => {
    const plan = editPlaybackPlan(
      cutEdit([
        [0, 30],
        [45, 90],
        [120, 150],
      ]),
    );
    expect(plan?.segments).toEqual([
      { sourceStart: 0, sourceEnd: 30, timelineStart: 0 },
      { sourceStart: 45, sourceEnd: 90, timelineStart: 30 },
      { sourceStart: 120, sourceEnd: 150, timelineStart: 75 },
    ]);
    expect(plan?.durationFrames).toBe(105);
  });

  it("joins ranges that touch, so no seek happens between them", () => {
    const plan = editPlaybackPlan(
      cutEdit([
        [0, 30],
        [30, 60],
        [90, 100],
      ]),
    );
    expect(plan?.segments).toEqual([
      { sourceStart: 0, sourceEnd: 60, timelineStart: 0 },
      { sourceStart: 90, sourceEnd: 100, timelineStart: 60 },
    ]);
  });

  it("orders items by their place on the timeline, not in the file", () => {
    const plan = editPlaybackPlan(
      editOf([
        { start: 10, duration: 5, in: 100 },
        { start: 0, duration: 10, in: 0 },
      ]),
    );
    expect(plan?.segments.map((segment) => segment.sourceStart)).toEqual([0, 100]);
  });

  it("plays the first clip and counts items on other clips", () => {
    const plan = editPlaybackPlan(
      editOf([
        { start: 0, duration: 10, in: 0 },
        { media: "other", start: 10, duration: 10, in: 0 },
      ]),
    );
    expect(plan?.mediaId).toBe("clip");
    expect(plan?.otherClipItems).toBe(1);
  });

  it("has no plan for an edit with nothing on the timeline", () => {
    expect(editPlaybackPlan(editOf([]))).toBeNull();
    expect(editPlaybackPlan({ ...editOf([]), tracks: [] })).toBeNull();
  });

  it("converts frames and times at 30 and 29.97 fps", () => {
    expect(timeOfFrame(30, FPS_30)).toBeCloseTo(1.016_667, 5);
    expect(frameAtTime(1, FPS_30)).toBe(30);
    expect(frameAtTime(timeOfFrame(30, FPS_30), FPS_30)).toBe(30);
    for (const frame of [0, 1, 29, 30, 1_799, 53_946]) {
      expect(frameAtTime(timeOfFrame(frame, FPS_2997), FPS_2997)).toBe(frame);
      // The frame's own start time, as the decoder reports it.
      expect(frameAtTime((frame * 1_001) / 30_000, FPS_2997)).toBe(frame);
    }
  });

  it("keeps a frame whose start is rounded down to the millisecond (WebM)", () => {
    const fps = { num: 24_000, den: 1_001 };
    // Frame 3 starts at 125.125 ms; WebM stores 125 ms.
    expect(frameAtTime(0.125, fps)).toBe(3);
  });

  it("formats the clock in minutes or hours", () => {
    expect(formatPlaybackClock(0, FPS_30)).toBe("0:00");
    expect(formatPlaybackClock(30 * 75, FPS_30)).toBe("1:15");
    expect(formatPlaybackClock(30 * 3_725, FPS_30)).toBe("1:02:05");
  });
});

describe("editPlayback finds the next keep start", () => {
  const segments = editPlaybackPlan(
    cutEdit([
      [0, 30],
      [45, 90],
      [120, 150],
    ]),
  )!.segments;

  it("keeps playing inside a range", () => {
    expect(stepAfterFrame(segments, 10)).toEqual({ _tag: "play" });
    expect(stepAfterFrame(segments, 45)).toEqual({ _tag: "play" });
  });

  it("skips at the last kept frame, before a cut frame shows", () => {
    expect(stepAfterFrame(segments, 29)).toEqual({ _tag: "skip", toSegment: 1, toFrame: 45 });
    expect(stepAfterFrame(segments, 89)).toEqual({ _tag: "skip", toSegment: 2, toFrame: 120 });
  });

  it("skips from inside a removed range", () => {
    expect(stepAfterFrame(segments, 30)).toEqual({ _tag: "skip", toSegment: 1, toFrame: 45 });
    expect(stepAfterFrame(segments, 100)).toEqual({ _tag: "skip", toSegment: 2, toFrame: 120 });
  });

  it("ends after the last range", () => {
    expect(stepAfterFrame(segments, 149)).toEqual({ _tag: "end" });
    expect(stepAfterFrame(segments, 400)).toEqual({ _tag: "end" });
  });

  it("maps between edit frames and source frames", () => {
    expect(timelineFrameOf(segments, 50)).toBe(35);
    expect(timelineFrameOf(segments, 35)).toBe(30);
    expect(timelineFrameOf(segments, 500)).toBe(105);
    expect(sourceFrameOf(segments, 35)).toBe(50);
    expect(sourceFrameOf(segments, 30)).toBe(45);
    expect(sourceFrameOf(segments, 104)).toBe(149);
    expect(sourceFrameOf(segments, 999)).toBe(149);
    expect(sourceFrameOf([], 10)).toBe(0);
  });

  it("plays a whole clip as one range", () => {
    const plan = clipPlaybackPlan("clip", 300, FPS_30);
    expect(plan.segments).toEqual([{ sourceStart: 0, sourceEnd: 300, timelineStart: 0 }]);
    expect(stepAfterFrame(plan.segments, 299)).toEqual({ _tag: "end" });
  });
});

describe("editPlayback handles many tiny cuts", () => {
  it("skips 300 one-frame cuts, each to the next kept frame", () => {
    const ranges = Array.from({ length: 301 }, (_, index) => [index * 3, index * 3 + 2] as const);
    const segments = editPlaybackPlan(cutEdit(ranges))!.segments;
    expect(segments).toHaveLength(301);
    let frame = 0;
    let skips = 0;
    for (;;) {
      const step = stepAfterFrame(segments, frame);
      if (step._tag === "end") break;
      if (step._tag === "skip") {
        expect(step.toFrame - frame).toBe(2);
        skips += 1;
        frame = step.toFrame;
      } else frame += 1;
    }
    expect(skips).toBe(300);
  });
});
