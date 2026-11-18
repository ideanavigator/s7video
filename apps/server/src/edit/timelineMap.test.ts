// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** S7V-036: clip frames through the cut, and speech ranges for the music's duck. */
import { type EditDocument, type EditRational, emptyEditDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  snapToWord,
  speechRanges,
  timecode,
  timelineFrameOf,
  timelineRangesOf,
} from "./timelineMap.ts";

const edit = (
  fps: EditRational,
  items: ReadonlyArray<
    readonly [start: number, duration: number, sourceIn: number, media?: string]
  >,
): EditDocument => ({
  ...emptyEditDocument({ fps, canvas: { width: 1080, height: 1920 } }),
  tracks: [
    {
      kind: "video",
      id: "V1",
      items: items.map(([start, duration, sourceIn, media = "cam"], index) => ({
        id: `v${index}`,
        media,
        start,
        duration,
        in: sourceIn,
      })),
    },
  ],
});

const fps30 = { num: 30, den: 1 };

describe("timelineFrameOf", () => {
  it("maps a clip frame through three kept ranges, and a cut frame to null", () => {
    const document = edit(fps30, [
      [0, 30, 0],
      [30, 30, 50],
      [60, 30, 100],
    ]);
    expect(timelineFrameOf(document, "cam", 12, fps30)).toBe(12);
    expect(timelineFrameOf(document, "cam", 55, fps30)).toBe(35);
    expect(timelineFrameOf(document, "cam", 129, fps30)).toBe(89);
    expect(timelineFrameOf(document, "cam", 40, fps30)).toBeNull();
    expect(timelineFrameOf(document, "cam", 130, fps30)).toBeNull();
    expect(timelineFrameOf(document, "other", 12, fps30)).toBeNull();
  });

  it("rescales the clip's rate to the edit's, half up like the engine's _to_rate", () => {
    const ntsc = { num: 30000, den: 1001 };
    // 1000 frames at 30 fps are 999.0 frames at 29.97.
    expect(timelineFrameOf(edit(ntsc, [[0, 2000, 0]]), "cam", 1000, fps30)).toBe(999);
    // A 24 fps clip on a 30 fps edit: frame 2 is 2.5 frames, which rounds up.
    expect(timelineFrameOf(edit(fps30, [[0, 300, 0]]), "cam", 2, { num: 24, den: 1 })).toBe(3);
  });

  it("uses the first place a clip plays the frame", () => {
    const document = edit(fps30, [
      [0, 30, 0],
      [30, 30, 100, "b-roll"],
      [60, 30, 0],
    ]);
    expect(timelineFrameOf(document, "cam", 10, fps30)).toBe(10);
  });
});

describe("speechRanges", () => {
  const transcript = (fps: EditRational, words: ReadonlyArray<readonly [number, number]>) =>
    new Map([
      [
        "cam",
        {
          fps,
          words: words.map(([startFrame, endFrame], index) => ({
            text: `w${index}`,
            startFrame,
            endFrame,
          })),
        },
      ],
    ]);

  it.each([
    [fps30, 8, 9],
    [{ num: 25, den: 1 }, 7, 8],
    [{ num: 30000, den: 1001 }, 8, 9],
  ])("at %j merges a gap of %i frames (under 300 ms) but not %i", (fps, merged, kept) => {
    const document = edit(fps, [[0, 300, 0]]);
    const words = [
      [10, 20],
      [20 + merged, 40],
      [40 + kept, 60],
    ] as const;
    expect(speechRanges(document, transcript(fps, words))).toEqual([
      { start: 10, end: 40 },
      { start: 40 + kept, end: 60 },
    ]);
  });

  it("follows the cut: words in removed ranges are dropped, the rest move", () => {
    const document = edit(fps30, [
      [0, 30, 0],
      [30, 30, 100],
    ]);
    const ranges = speechRanges(
      document,
      transcript(fps30, [
        [5, 15],
        [50, 70],
        [105, 120],
      ]),
    );
    expect(ranges).toEqual([
      { start: 5, end: 15 },
      { start: 35, end: 50 },
    ]);
  });
});

describe("snapToWord", () => {
  const transcript = {
    fps: fps30,
    words: [
      { text: "Hello", startFrame: 10, endFrame: 20 },
      { text: " ", startFrame: 21, endFrame: 22 },
      { text: "today", startFrame: 30, endFrame: 45 },
    ],
  };
  const document = edit(fps30, [[0, 300, 0]]);

  it("snaps inside a word to its start, between words to the next, and past the end to null", () => {
    expect(snapToWord(document, "cam", transcript, 15)).toEqual({ frame: 10, word: "Hello" });
    expect(snapToWord(document, "cam", transcript, 20)).toEqual({ frame: 30, word: "today" });
    // A blank word is no word, as for captions.
    expect(snapToWord(document, "cam", transcript, 21)).toEqual({ frame: 30, word: "today" });
    expect(snapToWord(document, "cam", transcript, 45)).toBeNull();
  });
});

// S7V-037: a zoom's clip-frame range, as the timeline ranges that play it.
describe("timelineRangesOf", () => {
  it("gives the kept pieces of a range in timeline order, and nothing when it was all cut", () => {
    const document = edit(fps30, [
      [0, 30, 0],
      [30, 30, 50],
      [60, 30, 100],
    ]);
    expect(timelineRangesOf(document, "cam", 20, 60, fps30)).toEqual([
      { start: 20, end: 30 },
      { start: 30, end: 40 },
    ]);
    expect(timelineRangesOf(document, "cam", 10, 120, fps30)).toEqual([
      { start: 10, end: 30 },
      { start: 30, end: 60 },
      { start: 60, end: 80 },
    ]);
    expect(timelineRangesOf(document, "cam", 32, 48, fps30)).toEqual([]);
    expect(timelineRangesOf(document, "other", 0, 30, fps30)).toEqual([]);
  });

  it("keeps a split clip's range whole: the split continues the source", () => {
    const document = edit(fps30, [
      [0, 40, 0],
      [40, 60, 40],
    ]);
    expect(timelineRangesOf(document, "cam", 20, 70, fps30)).toEqual([{ start: 20, end: 70 }]);
  });

  it("zooms a frame placed twice only where it first plays", () => {
    const document = edit(fps30, [
      [0, 30, 100],
      [30, 100, 50],
    ]);
    // Source 100-130 plays first at 0-30; the rest of 60-140 plays in the second item.
    expect(timelineRangesOf(document, "cam", 60, 140, fps30)).toEqual([
      { start: 0, end: 30 },
      { start: 40, end: 80 },
      { start: 110, end: 120 },
    ]);
  });

  it("keeps range edges on frame boundaries at 29.97", () => {
    const ntsc = { num: 30000, den: 1001 };
    const document = edit(ntsc, [[0, 2000, 0]]);
    // 1000 and 1500 frames at 30 fps are 999.0 and 1498.5 frames at 29.97, half up.
    expect(timelineRangesOf(document, "cam", 1000, 1500, fps30)).toEqual([
      { start: 999, end: 1499 },
    ]);
    // A one-frame range never maps to nothing.
    expect(timelineRangesOf(document, "cam", 1000, 1001, fps30)).toEqual([
      { start: 999, end: 1000 },
    ]);
  });

  it("names a timeline place as minutes, seconds and hundredths", () => {
    expect(timecode(126, fps30)).toBe("00:04.20");
    expect(timecode(30 * 75, fps30)).toBe("01:15.00");
  });
});
