// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import type { TimelineItem, TimelineRow } from "./timelineModel";
import { deleteOps, planGesture, splitOps } from "./timelineEdits";

const item = (
  id: string,
  start: number,
  duration: number,
  linkId: string | null = null,
): TimelineItem => ({
  id,
  start,
  duration,
  label: id,
  mediaId: "cam",
  in: 0,
  linkId,
  mediaFrames: 10_000,
});
const row = (
  id: string,
  kind: TimelineRow["kind"],
  items: TimelineItem[],
  locked = false,
): TimelineRow => ({
  id,
  kind,
  label: id,
  items,
  muted: false,
  locked,
  real: true,
});

const rows = [
  row("V1", "video", [item("v1", 0, 100, "L"), item("v2", 100, 50)]),
  row("V2", "video", []),
  row("A1", "sfx", [item("a1", 0, 100, "L")]),
  row("M1", "music", [item("m1", 0, 300)], true),
];

describe("planGesture", () => {
  it("sends one moveItem per link group, with frames planned from the rows", () => {
    const planned = planGesture(rows, {
      kind: "move",
      delta: 200,
      itemIds: ["v1", "a1"],
      toRowId: null,
    });
    expect(planned).toMatchObject({
      refused: null,
      ops: [{ _tag: "moveItem", itemId: "v1", start: 200 }],
    });
    expect(planned.blocks.map((block) => [block.itemId, block.start])).toEqual([
      ["v1", 200],
      ["a1", 200],
    ]);
  });

  it("names the target track when a clip moves rows", () => {
    expect(
      planGesture(rows, { kind: "move", delta: 0, itemIds: ["v2"], toRowId: "V2" }).ops,
    ).toEqual([{ _tag: "moveItem", itemId: "v2", start: 100, toTrackId: "V2" }]);
  });

  it("refuses an overlap, and a clip that is gone", () => {
    expect(
      planGesture(rows, { kind: "move", delta: -50, itemIds: ["v2"], toRowId: null }).refused,
    ).toBe("overlap");
    expect(
      planGesture(rows, { kind: "move", delta: 5, itemIds: ["gone"], toRowId: null }).refused,
    ).toBe("missing");
  });

  it("sends a trim as trimItem at the edge's new frame", () => {
    expect(
      planGesture(rows, { kind: "trim", side: "end", delta: -30, itemIds: ["v2"] }).ops,
    ).toEqual([{ _tag: "trimItem", itemId: "v2", edge: "end", frame: 120 }]);
    expect(
      planGesture(rows, { kind: "trim", side: "start", delta: 10, itemIds: ["v1", "a1"] }).ops,
    ).toEqual([{ _tag: "trimItem", itemId: "v1", edge: "start", frame: 10 }]);
  });
});

describe("splitOps", () => {
  it("splits every clip under the playhead on unlocked tracks, once per link group", () => {
    expect(splitOps(rows, new Set(), 40)).toEqual([
      { _tag: "splitItem", itemId: "v1", atFrame: 40 },
    ]);
  });

  it("splits only the selection when there is one", () => {
    expect(splitOps(rows, new Set(["v2"]), 120)).toEqual([
      { _tag: "splitItem", itemId: "v2", atFrame: 120 },
    ]);
    expect(splitOps(rows, new Set(["v2"]), 40)).toEqual([]);
  });

  it("does nothing on a clip's first frame or at its end", () => {
    expect(splitOps(rows, new Set(["v2"]), 100)).toEqual([]);
    expect(splitOps(rows, new Set(["v2"]), 150)).toEqual([]);
  });
});

describe("deleteOps", () => {
  it("deletes the selection with its linked items, as a gap or rippled", () => {
    expect(deleteOps(rows, new Set(["a1"]), false)).toEqual([
      { _tag: "deleteItem", itemIds: ["a1"], ripple: false },
    ]);
    expect(deleteOps(rows, new Set(["v2"]), true)).toEqual([
      { _tag: "deleteItem", itemIds: ["v2"], ripple: true },
    ]);
  });

  it("leaves clips on locked tracks alone", () => {
    expect(deleteOps(rows, new Set(["m1"]), false)).toEqual([]);
  });
});
