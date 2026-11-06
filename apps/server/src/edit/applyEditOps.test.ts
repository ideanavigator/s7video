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

  it("never changes the document it was given", () => {
    const frozen = structuredClone(base);
    run([keep([[0, 10]]), { _tag: "setCaptionStyle", trackId: "C1", style: "s7-box" }], frozen);
    expect(frozen).toEqual(base);
  });
});
