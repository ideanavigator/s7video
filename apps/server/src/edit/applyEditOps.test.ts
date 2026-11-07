// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { type EditDocument, type EditOp, validateEditDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";

const base: EditDocument = {
  version: 1,
  fps: { num: 30000, den: 1001 },
  canvas: { width: 1080, height: 1920 },
  media: [
    {
      id: "cam",
      kind: "video",
      path: "assets/cam.mov",
      fingerprint: { sha256: "cd".repeat(32), size: 10 },
      probe: { durationFrames: 1000, hasVideo: true, hasAudio: true },
    },
  ],
  tracks: [
    { kind: "video", id: "V1", items: [] },
    { kind: "caption", id: "C1", items: [] },
  ],
  markers: [],
  metadata: {},
};

const run = (ops: ReadonlyArray<EditOp>, document: EditDocument = base) => {
  const result = applyEditOps(document, ops);
  if (result._tag === "failed") throw new Error(result.error.explanation);
  const validated = validateEditDocument(result.document);
  if (!validated.ok) throw new Error(validated.issues[0]!.explanation);
  return validated.document;
};

const items = (document: EditDocument, trackId = "V1") =>
  document.tracks
    .find((track) => track.id === trackId)!
    .items.map((item) => ({
      id: item.id,
      start: item.start,
      duration: item.duration,
      ...("in" in item ? { in: item.in } : {}),
    }));

const keep = (ranges: ReadonlyArray<readonly [number, number]>): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "cam",
  ranges: ranges.map(([at, duration]) => ({ in: at, duration })),
});

describe("applyEditOps", () => {
  it("apply setKeepRanges produces frame-exact items", () => {
    const document = run([
      keep([
        [0, 90],
        [120, 60],
        [400, 300],
      ]),
    ]);
    expect(items(document)).toEqual([
      { id: "v1", start: 0, duration: 90, in: 0 },
      { id: "v2", start: 90, duration: 60, in: 120 },
      { id: "v3", start: 150, duration: 300, in: 400 },
    ]);
    for (const item of items(document)) {
      for (const frame of [item.start, item.duration, item.in!]) {
        expect(Number.isInteger(frame)).toBe(true);
      }
    }
  });

  it("keeps ids and props of ranges that stay, and restores a removed range in place", () => {
    const cut = run([
      keep([
        [0, 90],
        [120, 60],
      ]),
      { _tag: "setItemProps", itemId: "v2", props: { gainDb: -3 } },
    ]);
    const restored = run(
      [{ _tag: "restoreRange", trackId: "V1", mediaId: "cam", range: { in: 90, duration: 30 } }],
      cut,
    );
    expect(items(restored)).toEqual([{ id: "v1", start: 0, duration: 180, in: 0 }]);
    const again = run(
      [
        keep([
          [0, 90],
          [120, 60],
        ]),
      ],
      cut,
    );
    expect(again.tracks[0]!.items[1]).toMatchObject({ id: "v2", gainDb: -3 });
  });

  it("gives a new range an id no kept range still uses (S7V-058)", () => {
    const cut = run([
      keep([
        [0, 90],
        [120, 60],
      ]),
    ]);
    // The first range splits; the second stays and keeps "v2".
    const tighter = run(
      [
        keep([
          [0, 40],
          [50, 40],
          [120, 60],
        ]),
      ],
      cut,
    );
    expect(items(tighter).map((item) => item.id)).toEqual(["v1", "v3", "v2"]);
    // A repeated source span: each old item is matched once, so both keep their own id.
    const twice = run([
      keep([
        [0, 90],
        [0, 90],
      ]),
    ]);
    expect(
      items(
        run(
          [
            keep([
              [0, 90],
              [0, 90],
            ]),
          ],
          twice,
        ),
      ).map((item) => item.id),
    ).toEqual(["v1", "v2"]);
  });

  it("splits, trims, moves and ripple-deletes on integer frames", () => {
    const start = run([
      keep([
        [0, 100],
        [200, 100],
      ]),
    ]);
    const split = run([{ _tag: "splitItem", itemId: "v1", atFrame: 40 }], start);
    expect(items(split)).toEqual([
      { id: "v1", start: 0, duration: 40, in: 0 },
      { id: "v3", start: 40, duration: 60, in: 40 },
      { id: "v2", start: 100, duration: 100, in: 200 },
    ]);
    const trimmed = run([{ _tag: "trimItem", itemId: "v2", edge: "start", frame: 110 }], split);
    expect(items(trimmed).at(-1)).toEqual({ id: "v2", start: 110, duration: 90, in: 210 });
    const rippled = run([{ _tag: "deleteItem", itemIds: ["v3"], ripple: true }], trimmed);
    expect(items(rippled)).toEqual([
      { id: "v1", start: 0, duration: 40, in: 0 },
      { id: "v2", start: 50, duration: 90, in: 210 },
    ]);
    const gap = run([{ _tag: "deleteItem", itemIds: ["v1"], ripple: false }], rippled);
    expect(items(gap)).toEqual([{ id: "v2", start: 50, duration: 90, in: 210 }]);
  });

  it("splits caption words between the two halves", () => {
    const document = run([
      {
        _tag: "setCaptions",
        trackId: "C1",
        captions: [
          {
            start: 0,
            duration: 30,
            text: "one two",
            words: [
              { text: "one", start: 0, duration: 10 },
              { text: "two", start: 15, duration: 15 },
            ],
          },
        ],
      },
      { _tag: "splitItem", itemId: "c1", atFrame: 15 },
    ]);
    expect(document.tracks[1]!.items).toMatchObject([
      { id: "c1", text: "one", duration: 15 },
      { id: "c2", text: "two", start: 15, duration: 15 },
    ]);
  });

  it("moves the source of a media overlay that has no in frame", () => {
    const withOverlay = run([
      { _tag: "addTrack", track: { kind: "overlay", id: "O1", items: [] } },
      {
        _tag: "insertItem",
        trackId: "O1",
        item: { id: "o1", media: "cam", start: 10, duration: 100 },
      },
    ]);
    const trimmed = run(
      [{ _tag: "trimItem", itemId: "o1", edge: "start", frame: 30 }],
      withOverlay,
    );
    expect(trimmed.tracks[2]!.items[0]).toMatchObject({ start: 30, duration: 80, in: 20 });
    const split = run([{ _tag: "splitItem", itemId: "o1", atFrame: 60 }], withOverlay);
    expect(split.tracks[2]!.items[1]).toMatchObject({ start: 60, duration: 50, in: 50 });
  });

  it("leaves no copied text on a caption half without words", () => {
    const document = run([
      {
        _tag: "setCaptions",
        trackId: "C1",
        captions: [
          {
            start: 0,
            duration: 40,
            text: "one two",
            words: [
              { text: "one", start: 0, duration: 12 },
              { text: "two", start: 10, duration: 14 },
            ],
          },
        ],
      },
      { _tag: "splitItem", itemId: "c1", atFrame: 30 },
    ]);
    expect(document.tracks[1]!.items).toMatchObject([
      { id: "c1", text: "one two", duration: 30 },
      { id: "c2", text: "", words: [], start: 30, duration: 10 },
    ]);
  });

  it("reports the op and item that cannot apply", () => {
    const result = applyEditOps(base, [
      keep([[0, 10]]),
      { _tag: "splitItem", itemId: "v1", atFrame: 10 },
    ]);
    expect(result).toMatchObject({
      _tag: "failed",
      error: { _tag: "EditOpError", opIndex: 1, op: "splitItem", itemId: "v1" },
    });
    const removed = applyEditOps(run([keep([[0, 10]])]), [{ _tag: "removeMedia", mediaId: "cam" }]);
    expect(removed).toMatchObject({ _tag: "failed", error: { itemId: "cam" } });
  });

  it("sets the canvas, and refuses an odd or zero size", () => {
    const chosen = run([{ _tag: "setCanvas", canvas: { width: 1894, height: 1080 } }]);
    expect(chosen.canvas).toEqual({ width: 1894, height: 1080 });
    // A shape someone asked for is marked chosen; the first clip's own shape is not.
    expect(chosen.metadata.canvasChosen).toBe(true);
    const fromClip = run([
      { _tag: "setCanvas", canvas: { width: 1894, height: 1080 }, fromClip: true },
    ]);
    expect(fromClip.metadata.canvasChosen).toBeUndefined();
    for (const canvas of [
      { width: 1895, height: 1080 },
      { width: 1080, height: 0 },
    ]) {
      expect(applyEditOps(base, [{ _tag: "setCanvas", canvas }])).toMatchObject({
        _tag: "failed",
        error: { _tag: "EditOpError", op: "setCanvas" },
      });
    }
  });

  it("never changes the document it was given", () => {
    const frozen = structuredClone(base);
    run([keep([[0, 10]]), { _tag: "setCaptionStyle", trackId: "C1", style: "s7-box" }], frozen);
    expect(frozen).toEqual(base);
  });

  describe("linked items (S7V-034)", () => {
    // A video item with its audio on an sfx track, linked; one unlinked video item after them.
    const linked: EditDocument = {
      ...base,
      media: [
        ...base.media,
        {
          id: "mic",
          kind: "audio",
          path: "assets/mic.wav",
          fingerprint: { sha256: "ef".repeat(32), size: 10 },
          probe: { durationFrames: 1000, hasVideo: false, hasAudio: true },
        },
      ],
      tracks: [
        {
          kind: "video",
          id: "V1",
          items: [
            { id: "v1", media: "cam", start: 0, duration: 100, in: 0, linkId: "L1" },
            { id: "v2", media: "cam", start: 100, duration: 50, in: 300 },
          ],
        },
        { kind: "caption", id: "C1", items: [] },
        {
          kind: "sfx",
          id: "A1",
          items: [{ id: "a1", media: "mic", start: 0, duration: 100, in: 0, linkId: "L1" }],
        },
      ],
    };

    it("moves linked items by the same frames, each on its own track", () => {
      const moved = run([{ _tag: "moveItem", itemId: "v1", start: 200 }], linked);
      expect(items(moved)).toEqual([
        { id: "v2", start: 100, duration: 50, in: 300 },
        { id: "v1", start: 200, duration: 100, in: 0 },
      ]);
      expect(items(moved, "A1")).toEqual([{ id: "a1", start: 200, duration: 100, in: 0 }]);
    });

    it("trims linked items on the same edge by the same frames", () => {
      const trimmed = run(
        [
          { _tag: "trimItem", itemId: "a1", edge: "start", frame: 10 },
          { _tag: "trimItem", itemId: "v1", edge: "end", frame: 90 },
        ],
        linked,
      );
      expect(items(trimmed)[0]).toEqual({ id: "v1", start: 10, duration: 80, in: 10 });
      expect(items(trimmed, "A1")).toEqual([{ id: "a1", start: 10, duration: 80, in: 10 }]);
    });

    it("splits linked items together, and links the right-hand parts to each other", () => {
      const result = applyEditOps(linked, [
        { _tag: "splitItem", itemId: "v1", atFrame: 40, newItemId: "v1b" },
      ]);
      if (result._tag === "failed") throw new Error(result.error.explanation);
      const [video, , audio] = result.document.tracks;
      expect(video!.items.slice(0, 2)).toMatchObject([
        { id: "v1", start: 0, duration: 40, in: 0, linkId: "L1" },
        { id: "v1b", start: 40, duration: 60, in: 40, linkId: "L1.v1b" },
      ]);
      expect(audio!.items).toMatchObject([
        { start: 0, duration: 40, in: 0, linkId: "L1" },
        { start: 40, duration: 60, in: 40, linkId: "L1.v1b" },
      ]);
      expect(validateEditDocument(result.document).ok).toBe(true);
      // The new parts move together, apart from the left halves.
      const audioRight = audio!.items[1]!.id;
      const moved = run([{ _tag: "moveItem", itemId: "v1b", start: 400 }], result.document);
      expect(items(moved, "A1")).toEqual([
        { id: "a1", start: 0, duration: 40, in: 0 },
        { id: audioRight, start: 400, duration: 60, in: 40 },
      ]);
    });

    it("deletes linked items together, and ripple closes each track's gap", () => {
      const gap = run([{ _tag: "deleteItem", itemIds: ["v1"], ripple: false }], linked);
      expect(items(gap)).toEqual([{ id: "v2", start: 100, duration: 50, in: 300 }]);
      expect(items(gap, "A1")).toEqual([]);
      const rippled = run([{ _tag: "deleteItem", itemIds: ["a1", "v1"], ripple: true }], linked);
      expect(items(rippled)).toEqual([{ id: "v2", start: 0, duration: 50, in: 300 }]);
      expect(items(rippled, "A1")).toEqual([]);
    });

    it("refuses a linked trim that would read before the linked item's media", () => {
      const later = structuredClone(linked) as unknown as {
        tracks: Array<{ items: Array<Record<string, unknown>> }>;
      };
      Object.assign(later.tracks[0]!.items[0]!, { start: 50, duration: 50, in: 20 });
      Object.assign(later.tracks[2]!.items[0]!, { start: 50, duration: 50, in: 0 });
      // v1 can start 20 frames earlier; its linked a1 cannot start before its media.
      const result = applyEditOps(later as unknown as EditDocument, [
        { _tag: "trimItem", itemId: "v1", edge: "start", frame: 30 },
      ]);
      expect(result).toMatchObject({ _tag: "failed", error: { itemId: "a1" } });
    });
  });

  describe("caption words follow their caption (S7V-034)", () => {
    const captioned = run([
      {
        _tag: "setCaptions",
        trackId: "C1",
        captions: [
          {
            start: 0,
            duration: 30,
            text: "one two three",
            words: [
              { text: "one", start: 0, duration: 10 },
              { text: "two", start: 10, duration: 10 },
              { text: "three", start: 20, duration: 10 },
            ],
          },
          {
            start: 40,
            duration: 10,
            text: "four",
            words: [{ text: "four", start: 40, duration: 10 }],
          },
        ],
      },
    ]);

    it("moves a caption's words with it", () => {
      const moved = run([{ _tag: "moveItem", itemId: "c1", start: 100 }], captioned);
      expect(moved.tracks[1]!.items[1]).toMatchObject({
        id: "c1",
        start: 100,
        words: [
          { text: "one", start: 100 },
          { text: "two", start: 110 },
          { text: "three", start: 120 },
        ],
      });
    });

    it("drops and shortens words a trim cuts, and the text follows", () => {
      const trimmed = run(
        [
          { _tag: "trimItem", itemId: "c1", edge: "start", frame: 15 },
          { _tag: "trimItem", itemId: "c1", edge: "end", frame: 22 },
        ],
        captioned,
      );
      expect(trimmed.tracks[1]!.items[0]).toEqual({
        id: "c1",
        start: 15,
        duration: 7,
        text: "two three",
        words: [
          { text: "two", start: 15, duration: 5 },
          { text: "three", start: 20, duration: 2 },
        ],
      });
    });

    it("shifts later captions' words on a ripple delete", () => {
      const rippled = run([{ _tag: "deleteItem", itemIds: ["c1"], ripple: true }], captioned);
      expect(rippled.tracks[1]!.items).toEqual([
        {
          id: "c2",
          start: 10,
          duration: 10,
          text: "four",
          words: [{ text: "four", start: 10, duration: 10 }],
        },
      ]);
    });
  });
});
