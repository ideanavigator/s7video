// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { getTimelineSnapThresholdInFrames } from "../vendor/opencut/snapping";
import type { TimelineItem, TimelineRow } from "../timelineModel";
import { buildMoveGroup, buildSnapPoints, resolveGroupMove, snapGroupEdges } from "./groupMove";
import { buildResizeMembers, computeGroupResize } from "./groupResize";
import { SNAP_DISTANCE_PX } from "./resizeController";

const item = (
  id: string,
  start: number,
  duration: number,
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({
  id,
  start,
  duration,
  label: id,
  mediaId: "cam",
  in: 100,
  linkId: null,
  mediaFrames: 1000,
  ...extra,
});

const row = (
  id: string,
  kind: TimelineRow["kind"],
  items: TimelineItem[],
  extra: Partial<TimelineRow> = {},
): TimelineRow => ({
  id,
  kind,
  label: id,
  items,
  muted: false,
  locked: false,
  real: true,
  ...extra,
});

const rows: TimelineRow[] = [
  row("V1", "video", [item("a", 0, 50), item("b", 80, 40), item("c", 120, 30)]),
  row("V2", "video", [item("d", 100, 20)]),
  row("M1", "music", [item("m", 0, 200)]),
  row("kind:sfx", "sfx", [], { real: false }),
];

describe("groupResize (OpenCut port)", () => {
  it("trims within media bounds: in never below 0, the end never past the media", () => {
    const start = computeGroupResize(buildResizeMembers(rows, "b", []), "start", -500);
    // Left neighbour a ends at 50 and b reads from source 100: the neighbour stops it first.
    expect(start.updates[0]).toMatchObject({ start: 50, duration: 70, in: 70 });
    const media = computeGroupResize(
      buildResizeMembers([row("V1", "video", [item("x", 200, 50, { in: 20 })])], "x", []),
      "start",
      -500,
    );
    expect(media.updates[0]).toMatchObject({ start: 180, duration: 70, in: 0 });
    const end = computeGroupResize(
      buildResizeMembers([row("V1", "video", [item("x", 0, 50, { in: 900 })])], "x", []),
      "end",
      500,
    );
    expect(end.updates[0]).toMatchObject({ duration: 100 });
  });

  it("stops at the next clip, and trims to one frame at the least", () => {
    const end = computeGroupResize(buildResizeMembers(rows, "a", []), "end", 500);
    expect(end.delta).toBe(30);
    const shortest = computeGroupResize(buildResizeMembers(rows, "a", []), "end", -500);
    expect(shortest.updates[0]).toMatchObject({ start: 0, duration: 1 });
    const fromStart = computeGroupResize(buildResizeMembers(rows, "a", []), "start", 500);
    expect(fromStart.updates[0]).toMatchObject({ start: 49, duration: 1, in: 149 });
  });

  it("gives a caption no media limit", () => {
    const captions = [
      row("C1", "caption", [item("t", 10, 5, { mediaId: null, mediaFrames: null })]),
    ];
    const result = computeGroupResize(buildResizeMembers(captions, "t", []), "end", 5000);
    expect(result.updates[0]).toMatchObject({ duration: 5005, in: null });
  });

  it("trims linked items with the clip, within the tightest limit", () => {
    const linked = [
      row("V1", "video", [item("v", 10, 50, { linkId: "L" })]),
      row("A1", "sfx", [item("s", 10, 50, { linkId: "L", in: 5 }), item("x", 0, 8)]),
    ];
    const result = computeGroupResize(buildResizeMembers(linked, "v", []), "start", -9);
    // s can only go back to frame 8 (x ends there) though v could reach its source start.
    expect(result.delta).toBe(-2);
    expect(result.updates.map((update) => update.itemId).toSorted()).toEqual(["s", "v"]);
  });
});

describe("groupMove (OpenCut port)", () => {
  it("refuses a move that overlaps a neighbour, and allows one into a gap", () => {
    const group = buildMoveGroup(rows, "a", ["a"])!;
    expect(resolveGroupMove(group, rows, 60, 0).refused).toBe("overlap");
    const fits = resolveGroupMove(group, rows, 150, 0);
    expect(fits.refused).toBeNull();
    expect(fits.moves).toEqual([
      { itemId: "a", fromRowIndex: 0, toRowIndex: 0, start: 150, duration: 50 },
    ]);
  });

  it("moves to another track of the same kind only", () => {
    const group = buildMoveGroup(rows, "a", [])!;
    expect(resolveGroupMove(group, rows, 0, 1).moves[0]!.toRowIndex).toBe(1);
    expect(resolveGroupMove(group, rows, 0, 2).refused).toBe("other-kind");
    expect(resolveGroupMove(group, rows, 0, 3).refused).toBe("other-kind");
  });

  it("refuses a move on a locked track", () => {
    const locked = rows.map((entry, index) => (index === 1 ? { ...entry, locked: true } : entry));
    expect(resolveGroupMove(buildMoveGroup(locked, "a", [])!, locked, 0, 1).refused).toBe("locked");
  });

  it("never starts the group before frame 0", () => {
    const group = buildMoveGroup(rows, "b", ["b", "c"])!;
    const moved = resolveGroupMove(group, rows, -500, 0);
    expect(moved.moves.map((move) => move.start)).toEqual([0, 40]);
  });

  it("carries linked items on their own rows", () => {
    const linked = [
      row("V1", "video", [item("v", 10, 50, { linkId: "L" })]),
      row("A1", "sfx", [item("s", 10, 50, { linkId: "L" })]),
    ];
    const group = buildMoveGroup(linked, "v", [])!;
    const moved = resolveGroupMove(group, linked, 100, 0);
    expect(moved.moves).toEqual([
      { itemId: "v", fromRowIndex: 0, toRowIndex: 0, start: 100, duration: 50 },
      { itemId: "s", fromRowIndex: 1, toRowIndex: 1, start: 100, duration: 50 },
    ]);
  });

  it("snaps to the playhead and clip edges within 8 px, at any zoom", () => {
    for (const pxPerFrame of [0.5, 2, 8]) {
      const distance = getTimelineSnapThresholdInFrames({
        pixelsPerFrame: pxPerFrame,
        snapThresholdPx: SNAP_DISTANCE_PX,
      });
      const group = buildMoveGroup(rows, "d", [])!;
      const points = buildSnapPoints(rows, new Set(["d"]), 300);
      const within = Math.floor(distance);
      // The end edge (start + 20) near the playhead at 300 lands on it exactly.
      expect(snapGroupEdges(group, 280 - within, points, distance)).toMatchObject({
        anchorStart: 280,
        snapPoint: { type: "playhead", time: 300 },
      });
      // The start edge near c's end (150) lands on 150.
      expect(snapGroupEdges(group, 150 + Math.min(within, 4), points, distance).anchorStart).toBe(
        150,
      );
      // Just past 8 px nothing snaps.
      const beyond = Math.floor(distance) + 1 + 0.5 / pxPerFrame;
      const free = snapGroupEdges(group, 400 + beyond, points, distance);
      expect(free.snapPoint).toBeNull();
    }
  });
});
