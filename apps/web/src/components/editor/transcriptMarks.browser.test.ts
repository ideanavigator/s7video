// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { LegendListRef } from "@legendapp/list/react";
import type { Transcript } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildTranscriptModel } from "../../editor/transcriptModel";
import { createTranscriptMarks, USER_SCROLL_HOLD_MS } from "./transcriptMarks";

const FPS = { num: 30, den: 1 };
const transcript: Transcript = {
  transcriptVersion: 1,
  mediaFingerprint: { sha256: "0".repeat(64), size: 1 },
  model: "test",
  revision: "test",
  fps: FPS,
  durationFrames: 1_000,
  // Two rows: a 2 s pause after word 1.
  words: [
    { text: "a", startFrame: 0, endFrame: 10, confidence: null, speaker: "S1" },
    { text: "b", startFrame: 10, endFrame: 20, confidence: null, speaker: "S1" },
    { text: "c", startFrame: 100, endFrame: 110, confidence: null, speaker: "S1" },
  ],
  createdAt: "2026-11-06T00:00:00Z",
};
const segments = [{ sourceStart: 0, sourceEnd: 1_000, timelineStart: 0 }];

/** No word elements mounted, so every follow goes through `scrollToIndex`. */
const setup = () => {
  let clock = 0;
  const scrollToIndex = vi.fn(async () => {});
  const marks = createTranscriptMarks("marks-test-", () => clock);
  marks.attachList({
    scrollToIndex,
    getScrollableNode: () => document.body,
  } as unknown as LegendListRef);
  marks.update(buildTranscriptModel(transcript, { fps: FPS, segments }), segments);
  return { marks, scrollToIndex, advance: (ms: number) => (clock += ms) };
};

describe("transcriptMarks", () => {
  it("follows playback to the row of the playing word", () => {
    const { marks, scrollToIndex } = setup();
    marks.showFrame(105);
    expect(marks.current()).toBe(2);
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });

  it("holds the follow for 3 s after the user scrolls", () => {
    const { marks, scrollToIndex, advance } = setup();
    advance(10_000);
    marks.noteUserScroll();
    advance(USER_SCROLL_HOLD_MS - 1);
    marks.showFrame(5);
    expect(marks.current()).toBe(0);
    expect(scrollToIndex).not.toHaveBeenCalled();
    advance(2);
    marks.showFrame(15);
    expect(scrollToIndex).toHaveBeenCalledOnce();
  });

  it("re-marks without scrolling when the edit changes", () => {
    const { marks, scrollToIndex } = setup();
    marks.showFrame(105);
    scrollToIndex.mockClear();
    // The agent cuts word "c": the paused frame now shows no word, and the list stays put.
    const cut = [
      { sourceStart: 0, sourceEnd: 100, timelineStart: 0 },
      { sourceStart: 110, sourceEnd: 1_000, timelineStart: 100 },
    ];
    marks.update(buildTranscriptModel(transcript, { fps: FPS, segments: cut }), cut);
    expect(marks.current()).not.toBe(2);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
