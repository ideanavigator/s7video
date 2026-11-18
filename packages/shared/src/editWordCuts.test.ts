// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument, EditRational } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cutRangesOps,
  type FrameSpan,
  hasLinkedAudio,
  keptSpansOf,
  planWordCut,
  planWordRestore,
  type WordEditInput,
  wordCutOps,
  wordEditOps,
  wordRestoreOps,
  type WordSpan,
} from "./editWordCuts.ts";

const fps30: EditRational = { num: 30, den: 1 };

// a [0,10) b [20,30) c [40,50) d [60,70) e [80,90): 30 fps, air 3 frames, minimum 9 frames.
const WORDS: ReadonlyArray<WordSpan> = [0, 20, 40, 60, 80].map((start) => ({
  start,
  end: start + 10,
}));

const input = (
  first: number,
  last: number,
  kept: ReadonlyArray<FrameSpan> = [[0, 100]],
  words: ReadonlyArray<WordSpan> = WORDS,
  fps: EditRational = fps30,
  mediaFrames = 100,
): WordEditInput => ({ words, first, last, kept, mediaFrames, fps });

const documentOf = (
  items: ReadonlyArray<readonly [start: number, duration: number, sourceIn: number]>,
  extra: EditDocument["tracks"] = [],
  fps: EditRational = fps30,
): EditDocument => ({
  version: 1,
  fps,
  canvas: { width: 1080, height: 1920 },
  media: [
    {
      id: "cam",
      kind: "video",
      path: "assets/cam.mov",
      fingerprint: { sha256: "cd".repeat(32), size: 10 },
      probe: { durationFrames: 100, hasVideo: true, hasAudio: true },
    },
  ],
  tracks: [
    {
      kind: "video",
      id: "V1",
      items: items.map(([start, duration, sourceIn], index) => ({
        id: `v${index + 1}`,
        media: "cam",
        start,
        duration,
        in: sourceIn,
      })),
    },
    ...extra,
  ],
  markers: [],
  metadata: {},
});

describe("planWordCut", () => {
  it("should map a word selection to a frame range in the gap", () => {
    // c alone: from b's end + air to d's start - air.
    expect(planWordCut(input(2, 2))).toEqual({
      range: [33, 57],
      words: [2],
      widenedFrames: 0,
      widenedWords: [],
    });
  });

  it("should keep 0.1 s air around kept words", () => {
    const tight: WordSpan[] = [
      { start: 0, end: 10 },
      { start: 11, end: 20 },
      { start: 40, end: 50 },
    ];
    // A 1-frame gap has no room for air: the edge stays at the word.
    expect(planWordCut(input(1, 1, [[0, 100]], tight))?.range).toEqual([11, 37]);
  });

  it("should cut to the clip's edge when no kept word is beyond the selection", () => {
    expect(planWordCut(input(0, 0))?.range).toEqual([0, 17]);
    expect(planWordCut(input(4, 4))?.range).toEqual([73, 100]);
    // b already cut: a's nearest kept neighbour after it is c.
    const bCut: FrameSpan[] = [
      [0, 13],
      [37, 100],
    ];
    expect(planWordCut(input(0, 0, bCut))?.range).toEqual([0, 37]);
  });

  it("should widen a cut to avoid a segment under 0.3 s", () => {
    // An earlier cut ends at 12: cutting b would leave the 1-frame silence [12,13) alone.
    const kept: FrameSpan[] = [
      [0, 10],
      [12, 100],
    ];
    expect(planWordCut(input(1, 1, kept))).toEqual({
      range: [12, 37],
      words: [1],
      widenedFrames: 1,
      widenedWords: [],
    });
  });

  it("should give back silence before swallowing a short kept word", () => {
    // Only a short word x [10,14) plays before the selection, from frame 9.
    const words: WordSpan[] = [
      { start: 10, end: 14 },
      { start: 30, end: 40 },
      { start: 60, end: 70 },
    ];
    // Cut y: x keeps [9,18) by taking 1 frame back from the cut (minimum 9).
    expect(planWordCut(input(1, 1, [[9, 100]], words))).toMatchObject({
      range: [18, 57],
      widenedFrames: 0,
    });
    // No silence to give: x goes with the cut, and the UI is told.
    const close: WordSpan[] = [
      { start: 10, end: 14 },
      { start: 15, end: 40 },
      { start: 60, end: 70 },
    ];
    expect(planWordCut(input(1, 1, [[9, 100]], close))).toEqual({
      range: [9, 57],
      words: [1],
      widenedFrames: 6,
      widenedWords: [0],
    });
  });

  it("should handle a selection crossing an existing cut", () => {
    // c already cut: selecting b..d cuts b and d, from a's air to e's air.
    const kept: FrameSpan[] = [
      [0, 33],
      [57, 100],
    ];
    expect(planWordCut(input(1, 3, kept))).toMatchObject({ range: [13, 77], words: [1, 3] });
    expect(planWordCut(input(2, 2, kept))).toBeNull();
  });

  it("should handle zero-length words", () => {
    const words: WordSpan[] = [
      { start: 0, end: 10 },
      { start: 20, end: 20 },
      { start: 40, end: 50 },
    ];
    expect(planWordCut(input(1, 1, [[0, 100]], words))).toBeNull();
    // Not a neighbour either: cutting c reaches back to a.
    expect(planWordCut(input(2, 2, [[0, 100]], words))?.range).toEqual([13, 100]);
  });

  it("should handle 29.97 fps", () => {
    const ntsc = { num: 30000, den: 1001 };
    const cut = planWordCut(input(2, 2, [[0, 100]], WORDS, ntsc));
    // 0.1 s is 2.997 frames: 3 whole frames.
    expect(cut?.range).toEqual([33, 57]);
    for (const edge of cut!.range) expect(Number.isInteger(edge)).toBe(true);
  });
});

describe("planWordRestore", () => {
  it("should restore exactly what a cut removed", () => {
    for (const [first, last] of [
      [2, 2],
      [1, 3],
      [0, 0],
      [4, 4],
      [0, 4],
    ] as const) {
      const cut = planWordCut(input(first, last))!;
      const around: FrameSpan[] = [
        [0, cut.range[0]],
        [cut.range[1], 100],
      ];
      const kept = around.filter(([a, b]) => b > a);
      expect(planWordRestore(input(first, last, kept)).ranges).toEqual([cut.range]);
    }
  });

  it("should leave a cut neighbour cut and bring back only air toward it", () => {
    // b..d cut as one: restoring c brings back c and 3 frames each side.
    const kept: FrameSpan[] = [
      [0, 13],
      [77, 100],
    ];
    expect(planWordRestore(input(2, 2, kept))).toEqual({
      ranges: [[37, 53]],
      words: [2],
      pauseFrames: 0,
    });
  });

  it("should count the pauses a restore brings back beside kept words", () => {
    // b and c were cut with the gaps around them: [13,77).
    const kept: FrameSpan[] = [
      [0, 13],
      [77, 100],
    ];
    const words: WordSpan[] = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
      { start: 40, end: 50 },
      { start: 80, end: 90 },
    ];
    // Restoring b..c brings the whole gap back to a and d: [13,77). The words with air are
    // [17,33) and [37,53); the rest, 4 + 4 + 24 frames, is pause.
    expect(planWordRestore(input(1, 2, kept, words))).toEqual({
      ranges: [[13, 77]],
      words: [1, 2],
      pauseFrames: 32,
    });
  });

  it("should grow a restored island to the minimum segment", () => {
    const words: WordSpan[] = [
      { start: 0, end: 10 },
      { start: 30, end: 32 },
      { start: 33, end: 34 },
      { start: 60, end: 70 },
    ];
    // Restore the 1-frame word at 33: 32..37 with air, then grown to 9 frames, never into the
    // word before it.
    const restored = planWordRestore(input(2, 2, [[0, 13]], words));
    expect(restored.ranges).toEqual([[32, 41]]);
  });

  it("should restore nothing for a selection that plays", () => {
    expect(planWordRestore(input(1, 2))).toEqual({ ranges: [], words: [], pauseFrames: 0 });
  });
});

describe("word edit ops", () => {
  it("should keep other items in place on delete", () => {
    // The clip in two parts with a gap, and another clip's item after it on the same track.
    const document = documentOf([
      [0, 50, 0],
      [70, 50, 50],
    ]);
    const withOther: EditDocument = {
      ...document,
      tracks: [
        {
          ...document.tracks[0]!,
          items: [
            ...document.tracks[0]!.items,
            { id: "x1", media: "cam", start: 200, duration: 10, in: 90 },
          ],
        } as EditDocument["tracks"][number],
      ],
    };
    expect(wordCutOps(withOther, "cam", [33, 57])).toEqual([
      { _tag: "splitItem", itemId: "v1", atFrame: 33, newItemId: "vt1" },
      { _tag: "splitItem", itemId: "v2", atFrame: 77, newItemId: "vt2" },
      { _tag: "deleteItem", itemIds: ["vt1", "v2"], ripple: true },
    ]);
  });

  it("should never reuse an id in the document", () => {
    const document = documentOf([[0, 100, 0]]);
    const taken: EditDocument = {
      ...document,
      markers: [{ id: "vt1", frame: 0, label: "x" }] as unknown as EditDocument["markers"],
    };
    expect(wordCutOps(taken, "cam", [33, 57])).toEqual([
      { _tag: "splitItem", itemId: "v1", atFrame: 57, newItemId: "vt2" },
      { _tag: "splitItem", itemId: "v1", atFrame: 33, newItemId: "vt3" },
      { _tag: "deleteItem", itemIds: ["vt3"], ripple: true },
    ]);
  });

  it("cutRangesOps cuts many ranges in one item right to left (S7V-078)", () => {
    // Moved out of order: the second half of the source plays first, then a 10-frame gap.
    const document = documentOf([
      [0, 50, 50],
      [60, 50, 0],
    ]);
    expect(
      cutRangesOps(document, "cam", [
        [0, 5],
        [20, 30],
        [45, 55],
        [90, 100],
      ]),
    ).toEqual([
      // v1 plays 50-100: [50,55) at its start and [90,100) at its end.
      { _tag: "splitItem", itemId: "v1", atFrame: 40, newItemId: "vt1" },
      { _tag: "splitItem", itemId: "v1", atFrame: 5, newItemId: "vt2" },
      // v2 plays 0-50, cut right to left: [45,50), [20,30), then [0,5) at its start.
      { _tag: "splitItem", itemId: "v2", atFrame: 105, newItemId: "vt3" },
      { _tag: "splitItem", itemId: "v2", atFrame: 90, newItemId: "vt4" },
      { _tag: "splitItem", itemId: "v2", atFrame: 80, newItemId: "vt5" },
      { _tag: "splitItem", itemId: "v2", atFrame: 65, newItemId: "vt6" },
      { _tag: "deleteItem", itemIds: ["vt1", "v1", "vt3", "vt5", "v2"], ripple: true },
    ]);
  });

  it("cutRangesOps joins touching ranges and only cuts the named track", () => {
    const document = documentOf(
      [[0, 100, 0]],
      [
        {
          kind: "video",
          id: "V2",
          items: [{ id: "w1", media: "cam", start: 0, duration: 100, in: 0 }],
        },
      ],
    );
    expect(
      cutRangesOps(
        document,
        "cam",
        [
          [40, 50],
          [50, 60],
        ],
        "V1",
      ),
    ).toEqual([
      { _tag: "splitItem", itemId: "v1", atFrame: 60, newItemId: "vt1" },
      { _tag: "splitItem", itemId: "v1", atFrame: 40, newItemId: "vt2" },
      { _tag: "deleteItem", itemIds: ["vt2"], ripple: true },
    ]);
    expect(cutRangesOps(document, "cam", [], "V1")).toEqual([]);
  });

  it("wordCutOps equals cutRangesOps with one range", () => {
    const documents = [
      documentOf([[0, 100, 0]]),
      documentOf([
        [0, 50, 0],
        [70, 50, 50],
      ]),
      documentOf([
        [0, 40, 60],
        [50, 60, 0],
      ]),
    ];
    for (const document of documents) {
      for (const range of [
        [0, 10],
        [33, 57],
        [45, 100],
        [0, 100],
        [60, 60],
      ] as const) {
        expect(wordCutOps(document, "cam", range)).toEqual(cutRangesOps(document, "cam", [range]));
      }
    }
  });

  it("should turn restore into restoreRange", () => {
    const document = documentOf([
      [0, 33, 0],
      [33, 43, 57],
    ]);
    expect(keptSpansOf(document, "cam")).toEqual([
      [0, 33],
      [57, 100],
    ]);
    expect(wordRestoreOps(document, "cam", [[30, 60]])).toEqual([
      { _tag: "restoreRange", trackId: "V1", mediaId: "cam", range: { in: 33, duration: 24 } },
    ]);
    expect(wordEditOps(document, "cam", WORDS, { first: 2, last: 2 }, "restore")).toMatchObject({
      _tag: "restore",
      ops: [{ _tag: "restoreRange", range: { in: 33, duration: 24 } }],
    });
  });

  it("should refuse a clip whose sound is on its own track", () => {
    const linked = documentOf(
      [[0, 100, 0]],
      [
        {
          kind: "sfx",
          id: "A1",
          items: [{ id: "a1", media: "cam", start: 0, duration: 100, in: 0, linkId: "l1" }],
        } as unknown as EditDocument["tracks"][number],
      ],
    );
    const withLink: EditDocument = {
      ...linked,
      tracks: [
        {
          ...linked.tracks[0]!,
          items: [{ ...linked.tracks[0]!.items[0]!, linkId: "l1" }],
        } as EditDocument["tracks"][number],
        linked.tracks[1]!,
      ],
    };
    // Linked sound, and the same clip on a sound track without a link.
    for (const document of [withLink, linked]) {
      expect(hasLinkedAudio(document, "cam")).toBe(true);
      for (const action of ["cut", "restore"] as const) {
        expect(wordEditOps(document, "cam", WORDS, { first: 2, last: 2 }, action)).toEqual({
          _tag: "linked-audio",
        });
      }
    }
    // Another clip's sound on its own track is fine.
    const other = documentOf(
      [[0, 100, 0]],
      [
        {
          kind: "music",
          id: "M1",
          items: [{ id: "m1", media: "song", start: 0, duration: 100, in: 0 }],
        } as unknown as EditDocument["tracks"][number],
      ],
    );
    expect(hasLinkedAudio(other, "cam")).toBe(false);
  });

  it("should handle deleting every word", () => {
    const document = documentOf([[0, 100, 0]]);
    expect(wordEditOps(document, "cam", WORDS, { first: 4, last: 0 }, "cut")).toEqual({
      _tag: "cut",
      ops: [{ _tag: "deleteItem", itemIds: ["v1"], ripple: true }],
      cut: { range: [0, 100], words: [0, 1, 2, 3, 4], widenedFrames: 0, widenedWords: [] },
    });
    expect(wordEditOps(documentOf([]), "cam", WORDS, { first: 0, last: 4 }, "cut")).toEqual({
      _tag: "nothing",
    });
  });
});
