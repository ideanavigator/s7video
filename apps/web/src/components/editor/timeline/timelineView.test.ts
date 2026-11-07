// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { wheelScrollsRows } from "./timelineController";
import type { TimelineItem } from "./timelineModel";
import { clipSpanInView } from "./timelineView";

const item: TimelineItem = {
  id: "a",
  start: 100,
  duration: 50,
  label: "a",
  mediaId: "m",
  in: 400,
  linkId: null,
  mediaFrames: null,
};

describe("clipSpanInView", () => {
  it("gives the visible part of a clip in edit frames, source frames and pixels", () => {
    expect(clipSpanInView(item, { pxPerFrame: 2, startFrame: 120.4, endFrame: 400 })).toEqual({
      firstFrame: 120,
      endFrame: 150,
      sourceFirstFrame: 420,
      sourceEndFrame: 450,
      offsetPx: 40,
      widthPx: 60,
    });
    expect(clipSpanInView(item, { pxPerFrame: 1, startFrame: 0, endFrame: 130 })).toMatchObject({
      firstFrame: 100,
      endFrame: 130,
      offsetPx: 0,
      widthPx: 30,
    });
  });

  it("is empty for a clip off screen", () => {
    expect(clipSpanInView(item, { pxPerFrame: 1, startFrame: 300, endFrame: 400 }).widthPx).toBe(0);
  });
});

describe("wheelScrollsRows", () => {
  it("scrolls the rows only when they overflow and are not at the edge the wheel heads to", () => {
    expect(wheelScrollsRows(40, 0, 200, 240)).toBe(false);
    expect(wheelScrollsRows(40, 0, 300, 200)).toBe(true);
    expect(wheelScrollsRows(40, 100, 300, 200)).toBe(false);
    expect(wheelScrollsRows(-40, 100, 300, 200)).toBe(true);
    expect(wheelScrollsRows(-40, 0, 300, 200)).toBe(false);
  });
});
