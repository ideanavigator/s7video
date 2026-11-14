// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** S7V-036: where a sound or music goes, its fades, and the music's duck. */
import {
  type EditDocument,
  type EditRational,
  type EditTrack,
  emptyEditDocument,
  validateEditDocument,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";
import { duckOps, duckOver, framesForMs, placementOps } from "./audioPlacement.ts";

const fps30 = { num: 30, den: 1 };

const sound = (id: string, durationFrames: number) => ({
  id,
  kind: "audio" as const,
  path: `assets/${id}.wav`,
  fingerprint: { sha256: "ab".repeat(32), size: 10 },
  probe: { durationFrames, hasVideo: false, hasAudio: true },
});

const documentWith = (fps: EditRational, tracks: ReadonlyArray<EditTrack> = []): EditDocument => ({
  ...emptyEditDocument({ fps, canvas: { width: 1080, height: 1920 } }),
  media: [
    {
      id: "cam",
      kind: "video",
      path: "assets/cam.mp4",
      fingerprint: { sha256: "cd".repeat(32), size: 10 },
      probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
    },
    sound("whoosh", 40),
    sound("bed", 900),
    sound("short", 120),
    sound("tiny", 30),
  ],
  tracks: [
    {
      kind: "video",
      id: "V1",
      items: [{ id: "v0", media: "cam", start: 0, duration: 300, in: 0 }],
    },
    ...tracks,
  ],
});

/** Applies the placement and checks the edit still validates (no overlaps, fades fit). */
const placed = (document: EditDocument, ops: ReturnType<typeof placementOps>["ops"]) => {
  const result = applyEditOps(document, ops);
  if (result._tag !== "applied") throw new Error(result.error.message);
  expect(validateEditDocument(result.document).ok).toBe(true);
  return result.document;
};

describe("framesForMs", () => {
  it.each([
    [{ num: 25, den: 1 }, 4, 10, 13, 25],
    [fps30, 5, 12, 15, 30],
    [{ num: 30000, den: 1001 }, 4, 12, 15, 30],
  ])("at %j: attack %i, release %i, fade in %i, fade out %i", (fps, a, r, i, o) => {
    expect([150, 400, 500, 1000].map((ms) => framesForMs(ms, fps))).toEqual([a, r, i, o]);
  });
});

describe("placementOps", () => {
  it("puts a sound effect at its frame for its full length on a new sound effects track", () => {
    const document = documentWith(fps30);
    const placement = placementOps(document, {
      media: "whoosh",
      track: "sfx",
      start: 42,
      mediaFrames: 40,
      gainDb: -19,
    });
    expect(placement.item).toEqual({
      id: "sfx1",
      trackId: "S1",
      start: 42,
      duration: 40,
      gainDb: -19,
    });
    const after = placed(document, placement.ops);
    expect(after.tracks.at(-1)).toEqual({
      kind: "sfx",
      id: "S1",
      items: [{ id: "sfx1", media: "whoosh", start: 42, duration: 40, in: 0, gainDb: -19 }],
    });
  });

  it("trims a sound effect longer than the edit at the edit's end", () => {
    const placement = placementOps(documentWith(fps30), {
      media: "whoosh",
      track: "sfx",
      start: 290,
      mediaFrames: 40,
      gainDb: -9,
    });
    expect(placement.item.duration).toBe(10);
  });

  it("puts an overlapping sound effect on a second track, skipping locked ones", () => {
    const first = documentWith(fps30, [
      {
        kind: "sfx",
        id: "S1",
        items: [{ id: "a", media: "whoosh", start: 30, duration: 40, in: 0 }],
      },
      { kind: "sfx", id: "S9", locked: true, items: [] },
    ]);
    const placement = placementOps(first, {
      media: "whoosh",
      track: "sfx",
      start: 50,
      mediaFrames: 40,
      gainDb: -9,
    });
    expect(placement.item.trackId).toBe("S2");
    const after = placed(first, placement.ops);
    expect(after.tracks.filter((track) => track.kind === "sfx").map((track) => track.id)).toEqual([
      "S1",
      "S9",
      "S2",
    ]);
    // A free stretch of the first track is used again.
    const later = placementOps(after, {
      media: "whoosh",
      track: "sfx",
      start: 200,
      mediaFrames: 40,
      gainDb: -9,
    });
    expect(later.item.trackId).toBe("S1");
    expect(later.ops.map((op) => op._tag)).toEqual(["insertItem"]);
  });

  it("runs music to the edit's end with a 0.5 s fade in and a 1 s fade out", () => {
    const document = documentWith(fps30);
    const placement = placementOps(document, {
      media: "bed",
      track: "music",
      start: 0,
      mediaFrames: 900,
      gainDb: -28,
    });
    const after = placed(document, placement.ops);
    expect(after.tracks.at(-1)).toEqual({
      kind: "music",
      id: "M1",
      items: [
        {
          id: "music1",
          media: "bed",
          start: 0,
          duration: 300,
          in: 0,
          gainDb: -28,
          fadeInFrames: 15,
          fadeOutFrames: 30,
        },
      ],
    });
  });

  it("does not loop music shorter than the edit, and shares a short bed between its fades", () => {
    const document = documentWith(fps30);
    const short = placementOps(document, {
      media: "short",
      track: "music",
      start: 0,
      mediaFrames: 120,
      gainDb: -18,
    });
    expect(short.item.duration).toBe(120);
    const tiny = placementOps(document, {
      media: "tiny",
      track: "music",
      start: 0,
      mediaFrames: 30,
      gainDb: -18,
    });
    const after = placed(document, tiny.ops);
    const item = after.tracks.at(-1)!.items[0]!;
    expect(item).toMatchObject({ duration: 30, fadeInFrames: 10, fadeOutFrames: 20 });
  });

  // AC-8: a placed sound is an ordinary item, so the timeline's move, trim and delete work on it.
  it("leaves an item the timeline can move, trim and delete", () => {
    const document = documentWith(fps30);
    const { ops, item } = placementOps(document, {
      media: "whoosh",
      track: "sfx",
      start: 42,
      mediaFrames: 40,
      gainDb: -9,
    });
    const after = placed(document, ops);
    const moved = placed(after, [{ _tag: "moveItem", itemId: item.id, start: 100 }]);
    const trimmed = placed(moved, [{ _tag: "trimItem", itemId: item.id, edge: "end", frame: 120 }]);
    expect(trimmed.tracks.at(-1)!.items[0]).toMatchObject({ start: 100, duration: 20 });
    const deleted = placed(trimmed, [{ _tag: "deleteItem", itemIds: [item.id], ripple: false }]);
    expect(deleted.tracks.at(-1)!.items).toEqual([]);
  });
});

describe("duck", () => {
  const ranges = [
    { start: 10, end: 40 },
    { start: 100, end: 130 },
  ];

  it.each([
    [{ num: 25, den: 1 }, 4, 10],
    [fps30, 5, 12],
    [{ num: 30000, den: 1001 }, 4, 12],
  ])("at %j uses attack %i and release %i frames", (fps, attackFrames, releaseFrames) => {
    expect(duckOver(documentWith(fps), ranges, -12)).toEqual({
      depthDb: -12,
      attackFrames,
      releaseFrames,
      ranges,
    });
  });

  it("goes on every music track, and is left out where it is already the same", () => {
    const music = (id: string): EditTrack => ({
      kind: "music",
      id,
      items: [{ id: `${id}-bed`, media: "bed", start: 0, duration: 300, in: 0 }],
    });
    const document = documentWith(fps30, [music("M1"), music("M2")]);
    const duck = duckOver(document, ranges, -12);
    const ops = duckOps(document, duck);
    expect(ops).toEqual([
      { _tag: "setTrackProps", trackId: "M1", props: { duck } },
      { _tag: "setTrackProps", trackId: "M2", props: { duck } },
    ]);
    const after = placed(document, ops);
    expect(duckOps(after, duck)).toEqual([]);
    expect(duckOps(after, { ...duck, depthDb: -9 })).toHaveLength(2);
  });

  it("leaves locked music tracks alone, as placement does", () => {
    const document = documentWith(fps30, [
      { kind: "music", id: "M1", locked: true, items: [] },
      { kind: "music", id: "M2", items: [] },
    ]);
    const duck = duckOver(document, ranges, -12);
    expect(duckOps(document, duck)).toEqual([
      { _tag: "setTrackProps", trackId: "M2", props: { duck } },
    ]);
  });
});
