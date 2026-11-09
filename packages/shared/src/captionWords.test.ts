// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument, EditRational } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  captionItemsFor,
  captionMediaOf,
  captionTrackOps,
  mapCaptionWords,
  sameCaptions,
  transcriptCaptionTrackOf,
} from "./captionWords.ts";

const media = (id: string, hasAudio = true) => ({
  id,
  kind: "video" as const,
  path: `assets/${id}.mp4`,
  fingerprint: { sha256: "ab".repeat(32), size: 1 },
  probe: { durationFrames: 10_000, hasVideo: true, hasAudio },
});

type Placed = readonly [start: number, duration: number, sourceIn: number, media?: string];

const edit = (
  items: ReadonlyArray<Placed>,
  options: { fps?: EditRational; extraTracks?: EditDocument["tracks"] } = {},
): EditDocument => ({
  version: 1,
  fps: options.fps ?? { num: 30, den: 1 },
  canvas: { width: 1080, height: 1920 },
  media: [media("cam"), media("mute", false)],
  tracks: [
    {
      kind: "video",
      id: "V1",
      items: items.map(([start, duration, sourceIn, from], index) => ({
        id: `v${index + 1}`,
        media: from ?? "cam",
        start,
        duration,
        in: sourceIn,
      })),
    },
    ...(options.extraTracks ?? []),
  ],
  markers: [],
  metadata: {},
});

const transcript = (
  words: ReadonlyArray<readonly [string, number, number]>,
  fps: EditRational = { num: 30, den: 1 },
) =>
  new Map([
    [
      "cam",
      { fps, words: words.map(([text, startFrame, endFrame]) => ({ text, startFrame, endFrame })) },
    ],
  ]);

const flat = (document: EditDocument, words: ReturnType<typeof transcript>) =>
  mapCaptionWords(document, words).map((group) =>
    group.map((word) => [word.text, word.start, word.end]),
  );

describe("mapCaptionWords", () => {
  it("shifts kept words by the frames removed before them and drops cut words", () => {
    // Keeps 10-40 and 100-130: the second range starts on timeline frame 30.
    const document = edit([
      [0, 30, 10],
      [30, 30, 100],
    ]);
    const words = transcript([
      ["hello", 12, 20],
      ["there", 21, 30],
      ["gone", 50, 60],
      ["again", 105, 115],
    ]);
    expect(flat(document, words)).toEqual([
      [
        ["hello", 2, 10],
        ["there", 11, 20],
      ],
      [["again", 35, 45]],
    ]);
  });

  it("shortens a word crossing a cut, on each side it plays", () => {
    const document = edit([
      [0, 30, 0],
      [30, 30, 60],
    ]);
    const words = transcript([
      ["across", 25, 65],
      ["touch", 20, 30],
      ["after", 30, 60],
    ]);
    expect(flat(document, words)).toEqual([
      [
        ["touch", 20, 30],
        ["across", 25, 30],
      ],
      [["across", 30, 35]],
    ]);
  });

  it("joins a split (no cut) into one run, and keeps a gap's timing", () => {
    const document = edit([
      [0, 30, 0],
      [30, 30, 30],
      [80, 20, 200],
    ]);
    const words = transcript([
      ["a", 25, 35],
      ["b", 205, 210],
    ]);
    expect(flat(document, words)).toEqual([[["a", 25, 35]], [["b", 85, 90]]]);
  });

  it.each([
    [{ num: 30000, den: 1001 }, { num: 60000, den: 1001 }, 60, 30],
    [{ num: 25, den: 1 }, { num: 24000, den: 1001 }, 48, 50],
  ])("rounds words to the edit's rate %o from %o", (fps, sourceFps, sourceFrame, expected) => {
    const document = edit([[0, 1000, 0]], { fps });
    const words = transcript([["word", sourceFrame, sourceFrame + 20]], sourceFps);
    expect(mapCaptionWords(document, words)[0]![0]!.start).toBe(expected);
  });

  it("skips clips without a transcript and words with no text", () => {
    const document = edit([
      [0, 30, 0, "mute"],
      [30, 30, 0],
    ]);
    const words = transcript([
      [" ", 0, 10],
      ["kept", 10, 20],
    ]);
    expect(flat(document, words)).toEqual([[["kept", 40, 50]]]);
  });
});

describe("captionItemsFor and the track ops", () => {
  const document = edit([
    [0, 30, 0],
    [30, 30, 60],
  ]);
  const words = transcript([
    ["one", 0, 10],
    ["two", 12, 20],
    ["three", 65, 80],
  ]);

  it("makes one item per run with its words in timeline frames", () => {
    expect(captionItemsFor(document, words)).toEqual([
      {
        start: 0,
        duration: 20,
        text: "one two",
        words: [
          { text: "one", start: 0, duration: 10 },
          { text: "two", start: 12, duration: 8 },
        ],
        metadata: { s7: { media: "cam" } },
      },
      {
        start: 35,
        duration: 15,
        text: "three",
        words: [{ text: "three", start: 35, duration: 15 }],
        metadata: { s7: { media: "cam" } },
      },
    ]);
  });

  it("adds a marked track the first time and sets it after that", () => {
    const ops = captionTrackOps(document, words);
    expect(ops.map((op) => op._tag)).toEqual(["addTrack", "setCaptions"]);
    expect(ops[0]).toMatchObject({
      track: {
        kind: "caption",
        id: "C1",
        label: "Captions",
        metadata: { s7: { source: "transcript" } },
      },
    });
    const withTrack = edit(
      [
        [0, 30, 0],
        [30, 30, 60],
      ],
      {
        extraTracks: [
          { kind: "caption", id: "C1", items: [] },
          { kind: "caption", id: "C2", metadata: { s7: { source: "transcript" } }, items: [] },
        ],
      },
    );
    // A hand-written C1 is not the transcript track; C2 is.
    expect(transcriptCaptionTrackOf(withTrack)?.id).toBe("C2");
    expect(captionTrackOps(withTrack, words)).toEqual([
      { _tag: "setCaptions", trackId: "C2", captions: captionItemsFor(withTrack, words) },
    ]);
  });

  it("picks a free track id when C1 is taken by another track", () => {
    const taken = edit([[0, 30, 0]], { extraTracks: [{ kind: "caption", id: "C1", items: [] }] });
    expect(captionTrackOps(taken, words)[0]).toMatchObject({ track: { id: "C2" } });
  });

  it("compares captions without their ids", () => {
    const captions = captionItemsFor(document, words);
    const track = {
      kind: "caption" as const,
      id: "C1",
      items: captions.map((caption, index) => ({ ...caption, id: `c${index + 1}` })),
    };
    expect(sameCaptions(track, captions)).toBe(true);
    expect(sameCaptions(track, captions.slice(1))).toBe(false);
  });

  it("captions only clips with sound on the first video track", () => {
    expect(captionMediaOf(edit([[0, 30, 0, "mute"]]))).toEqual([]);
    expect(captionMediaOf(document)).toEqual(["cam"]);
  });
});
