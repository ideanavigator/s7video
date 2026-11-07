// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { isMountedClip, LOD_MIN_CLIP_PX, nextDetailScale, splitByDetail } from "./lod";
import type { TimelineItem } from "./timelineModel";

const item = (id: string, start: number, duration: number): TimelineItem => ({
  id,
  start,
  duration,
  label: id,
  mediaId: null,
  in: 0,
});

describe("lod", () => {
  it("sends clips under 4 px to the canvas strip", () => {
    expect(LOD_MIN_CLIP_PX).toBe(4);
    expect(isMountedClip(2, 2)).toBe(true);
    expect(isMountedClip(1, 3.99)).toBe(false);
    const items = [item("a", 0, 1), item("b", 1, 10), item("c", 11, 2), item("d", 40, 50)];
    const split = splitByDetail(items, 0, 30, 2);
    expect(split.mounted).toEqual([1, 2]);
    expect(split.strip.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("holds the detail scale through small zoom changes (hysteresis)", () => {
    expect(nextDetailScale(null, 2)).toBe(2);
    // A 1-frame clip at 4 px stays mounted while the zoom wobbles to 3.5 px...
    expect(nextDetailScale(4, 3.5)).toBe(4);
    expect(nextDetailScale(4, 4.6)).toBe(4);
    // ...and moves once the zoom leaves the band.
    expect(nextDetailScale(4, 3.2)).toBe(3.2);
    expect(nextDetailScale(4, 5)).toBe(5);
  });
});
