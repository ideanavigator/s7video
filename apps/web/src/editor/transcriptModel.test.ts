// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument, Transcript, TranscriptWord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { editPlaybackPlan, type PlaybackSegment } from "./editPlayback";
import {
  buildTranscriptModel,
  MAX_ROW_WORDS,
  PARAGRAPH_PAUSE_SECONDS,
  rowOfWord,
  samePlayback,
  seekFrameOfWord,
  selectionSummary,
  selectionToOps,
  withPendingEdit,
  wordAtSourceFrame,
  wordAtTimelineFrame,
} from "./transcriptModel";

const FPS = { num: 30, den: 1 };

const word = (text: string, startFrame: number, endFrame: number): TranscriptWord => ({
  text,
  startFrame,
  endFrame,
  confidence: null,
  speaker: "S1",
});

const transcriptOf = (
  words: ReadonlyArray<TranscriptWord>,
  fps: Transcript["fps"] = FPS,
): Transcript => ({
  transcriptVersion: 1,
  mediaFingerprint: { sha256: "0".repeat(64), size: 1 },
  model: "test",
  revision: "test",
  fps,
  durationFrames: 10_000,
  words,
  createdAt: "2026-11-06T00:00:00Z",
});

/** Kept source ranges as player segments, in edit order. */
const segmentsOf = (ranges: ReadonlyArray<readonly [number, number]>): PlaybackSegment[] => {
  let timeline = 0;
  return ranges.map(([start, end]) => {
    const segment = { sourceStart: start, sourceEnd: end, timelineStart: timeline };
    timeline += end - start;
    return segment;
  });
};

// hello [0,10) there [12,20) | cut [20,40) | general [40,50) | ...
const words = [
  word("hello", 0, 10),
  word("there", 12, 22),
  word("silence", 24, 36),
  word("general", 40, 50),
];

describe("transcriptModel", () => {
  it("marks removed words from keep ranges", () => {
    const model = buildTranscriptModel(transcriptOf(words), {
      fps: FPS,
      segments: segmentsOf([
        [0, 20],
        [40, 60],
      ]),
    });
    // "there" is partly kept (12-19), so it stays; "silence" lies wholly in the cut.
    expect(model.words.map((entry) => entry.removed)).toEqual([false, false, true, false]);
    expect(model.removedCount).toBe(1);
  });

  it("removes nothing without a plan, and everything when every part is cut", () => {
    expect(buildTranscriptModel(transcriptOf(words), null).removedCount).toBe(0);
    const allCut = buildTranscriptModel(transcriptOf(words), { fps: FPS, segments: [] });
    expect(allCut.removedCount).toBe(words.length);
  });

  it("groups paragraphs on long pauses", () => {
    const pause = PARAGRAPH_PAUSE_SECONDS * FPS.num;
    const model = buildTranscriptModel(
      transcriptOf([
        word("one", 0, 10),
        // Exactly 1.5 s of pause: same paragraph.
        word("two", 10 + pause, 20 + pause),
        // One frame more: a new paragraph.
        word("three", 21 + 2 * pause, 30 + 2 * pause),
      ]),
      null,
    );
    expect(model.rows.map((row) => [row.first, row.end, row.paragraphStart])).toEqual([
      [0, 2, true],
      [2, 3, true],
    ]);
  });

  it("splits a long run without pauses into rows that continue the paragraph", () => {
    const run = Array.from({ length: MAX_ROW_WORDS * 2 + 5 }, (_, index) =>
      word(`w${index}`, index * 5, index * 5 + 4),
    );
    const model = buildTranscriptModel(transcriptOf(run), null);
    expect(model.rows.map((row) => [row.first, row.paragraphStart])).toEqual([
      [0, true],
      [MAX_ROW_WORDS, false],
      [MAX_ROW_WORDS * 2, false],
    ]);
    expect(rowOfWord(model, MAX_ROW_WORDS * 2 - 1)).toBe(1);
    expect(rowOfWord(model, MAX_ROW_WORDS * 2)).toBe(2);
  });

  it("finds the word at a frame, including gaps", () => {
    const model = buildTranscriptModel(transcriptOf(words), null);
    expect(wordAtSourceFrame(model, 0)).toBe(0);
    expect(wordAtSourceFrame(model, 9)).toBe(0);
    // 10-11 is a gap between words.
    expect(wordAtSourceFrame(model, 10)).toBe(-1);
    expect(wordAtSourceFrame(model, 12)).toBe(1);
    expect(wordAtSourceFrame(model, 49)).toBe(3);
    expect(wordAtSourceFrame(model, 50)).toBe(-1);
  });

  it("never highlights a removed word, and maps edit frames through the cuts", () => {
    const segments = segmentsOf([
      [0, 20],
      [40, 60],
    ]);
    const model = buildTranscriptModel(transcriptOf(words), { fps: FPS, segments });
    // Edit frame 20 is source frame 40, the start of "general".
    expect(wordAtTimelineFrame(model, segments, 20)).toBe(3);
    expect(wordAtTimelineFrame(model, segments, 19)).toBe(1);
    for (let frame = 0; frame < 40; frame += 1) {
      expect(wordAtTimelineFrame(model, segments, frame)).not.toBe(2);
    }
    expect(wordAtTimelineFrame(model, [], 0)).toBe(-1);
  });

  it("seeks a kept word to its first kept frame and a removed word to the next kept frame", () => {
    const segments = segmentsOf([
      [0, 20],
      [40, 60],
    ]);
    const model = buildTranscriptModel(transcriptOf(words), { fps: FPS, segments });
    expect(seekFrameOfWord(model, segments, 0)).toBe(0);
    expect(seekFrameOfWord(model, segments, 1)).toBe(12);
    expect(seekFrameOfWord(model, segments, 2)).toBe(20);
    expect(seekFrameOfWord(model, segments, 3)).toBe(20);
    expect(seekFrameOfWord(model, [], 0)).toBeNull();
  });

  it("treats a rebuilt plan with the same frames as the same playback", () => {
    const ranges = [
      [0, 20],
      [40, 60],
    ] as const;
    const playback = { fps: FPS, segments: segmentsOf(ranges) };
    expect(samePlayback(playback, { fps: { ...FPS }, segments: segmentsOf(ranges) })).toBe(true);
    expect(
      samePlayback(playback, {
        fps: FPS,
        segments: segmentsOf([
          [0, 20],
          [41, 60],
        ]),
      }),
    ).toBe(false);
    expect(samePlayback(playback, { fps: { num: 25, den: 1 }, segments: playback.segments })).toBe(
      false,
    );
    expect(samePlayback(playback, { fps: FPS, segments: null })).toBe(false);
    expect(samePlayback(null, null)).toBe(true);
  });

  it("moves word frames to the edit's rate", () => {
    // 24000/1001 transcript on a 30 fps edit: frame 24 (1.001 s) is edit frame 30.03.
    const ntsc = { num: 24_000, den: 1_001 };
    const document = {
      version: 1 as const,
      fps: FPS,
      canvas: { width: 1920, height: 1080 },
      media: [],
      tracks: [
        {
          kind: "video" as const,
          id: "v1",
          items: [{ id: "a", media: "clip", start: 0, duration: 300, in: 0 }],
        },
      ],
      markers: [],
      metadata: {},
    };
    const plan = editPlaybackPlan(document)!;
    const model = buildTranscriptModel(transcriptOf([word("a", 24, 48)], ntsc), {
      fps: plan.fps,
      segments: plan.segments,
    });
    expect(model.words[0]).toMatchObject({ start: 30, end: 61 });
  });

  describe("text edits (S7V-038)", () => {
    // a [0,10) b [20,30) c [40,50) d [60,70), one item playing [0,100).
    const edited = [word("a", 0, 10), word("b", 20, 30), word("c", 40, 50), word("d", 60, 70)];
    const document = (items: ReadonlyArray<readonly [number, number, number]>): EditDocument => ({
      version: 1,
      fps: FPS,
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
          items: items.map(([start, duration, from], index) => ({
            id: `v${index + 1}`,
            media: "cam",
            start,
            duration,
            in: from,
          })),
        },
      ],
      markers: [],
      metadata: {},
    });

    it("turns a selection of kept words into split and ripple delete", () => {
      const model = buildTranscriptModel(transcriptOf(edited), {
        fps: FPS,
        segments: segmentsOf([[0, 100]]),
      });
      const edit = selectionToOps(
        model,
        { first: 1, last: 2 },
        document([[0, 100, 0]]),
        "cam",
        "cut",
      );
      expect(edit).toMatchObject({
        _tag: "cut",
        ops: [
          { _tag: "splitItem", itemId: "v1", atFrame: 57 },
          { _tag: "splitItem", itemId: "v1", atFrame: 13 },
          { _tag: "deleteItem", ripple: true },
        ],
        cut: { range: [13, 57], words: [1, 2] },
      });
      expect(selectionSummary(model, { first: 0, last: 3 })).toEqual({ kept: 4, removed: 0 });
      // The cut shows at once, until the new edit arrives.
      const pending = withPendingEdit(model, edit);
      expect(pending.words.map((entry) => entry.removed)).toEqual([false, true, true, false]);
      expect(pending.removedCount).toBe(2);
    });

    it("turns a selection of cut words into restoreRange", () => {
      const cutDocument = document([
        [0, 13, 0],
        [13, 43, 57],
      ]);
      const model = buildTranscriptModel(transcriptOf(edited), {
        fps: FPS,
        segments: segmentsOf([
          [0, 13],
          [57, 100],
        ]),
      });
      expect(selectionSummary(model, { first: 1, last: 2 })).toEqual({ kept: 0, removed: 2 });
      expect(
        selectionToOps(model, { first: 2, last: 1 }, cutDocument, "cam", "restore"),
      ).toMatchObject({
        _tag: "restore",
        ops: [
          { _tag: "restoreRange", trackId: "V1", mediaId: "cam", range: { in: 13, duration: 44 } },
        ],
      });
      expect(selectionToOps(model, { first: 1, last: 2 }, cutDocument, "cam", "cut")).toEqual({
        _tag: "nothing",
      });
    });

    it("should handle zero-length words: they cannot be selected alone", () => {
      const model = buildTranscriptModel(
        transcriptOf([word("a", 0, 10), word("uh", 20, 20), word("c", 40, 50)]),
        { fps: FPS, segments: segmentsOf([[0, 100]]) },
      );
      expect(model.words[1]).toMatchObject({ timed: false });
      expect(selectionSummary(model, { first: 1, last: 1 })).toEqual({ kept: 0, removed: 0 });
      expect(
        selectionToOps(model, { first: 1, last: 1 }, document([[0, 100, 0]]), "cam", "cut"),
      ).toEqual({ _tag: "nothing" });
    });
  });
});
