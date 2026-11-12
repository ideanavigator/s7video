// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** S7V-037: a punch-in splits the items it covers in part, then zooms every covered part. */
import { type EditDocument, emptyEditDocument, validateEditDocument } from "@t3tools/contracts";
import { captionRuns } from "@t3tools/shared/captionWords";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";
import { parseZoomRange, zoomOps } from "./zoomOps.ts";

const zoom = { scale: 1.25, anchorX: 0.5, anchorY: 1 / 3, rampFrames: 0 };

const edit = (
  items: ReadonlyArray<readonly [start: number, duration: number, sourceIn: number]>,
): EditDocument => ({
  ...emptyEditDocument({ fps: { num: 30, den: 1 }, canvas: { width: 1080, height: 1920 } }),
  media: [
    {
      id: "cam",
      kind: "video",
      path: "assets/cam.mp4",
      fingerprint: { sha256: "ab".repeat(32), size: 10 },
      probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
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
  ],
});

const applied = (document: EditDocument, ops: ReturnType<typeof zoomOps>["ops"]) => {
  const result = applyEditOps(document, ops);
  if (result._tag === "failed") throw new Error(result.error.explanation);
  const validated = validateEditDocument(result.document);
  if (!validated.ok) throw new Error(validated.issues[0]!.explanation);
  return validated.document;
};

const layout = (document: EditDocument) =>
  document.tracks[0]!.items.map((item) => ({
    id: item.id,
    start: item.start,
    duration: item.duration,
    zoomed: "zoom" in item && item.zoom !== undefined,
  }));

describe("zoomOps", () => {
  it("splits at range edges then sets zoom, in one batch", () => {
    const document = edit([[0, 300, 0]]);
    const planned = zoomOps(document, [{ start: 100, end: 160 }], zoom);
    expect(planned.ops).toEqual([
      { _tag: "splitItem", itemId: "v1", atFrame: 160, newItemId: "vz1" },
      { _tag: "splitItem", itemId: "v1", atFrame: 100, newItemId: "vz2" },
      { _tag: "setItemProps", itemId: "vz2", props: { zoom } },
    ]);
    expect(planned.items).toBe(1);
    const after = applied(document, planned.ops);
    expect(layout(after)).toEqual([
      { id: "v1", start: 0, duration: 100, zoomed: false },
      { id: "vz2", start: 100, duration: 60, zoomed: true },
      { id: "vz1", start: 160, duration: 140, zoomed: false },
    ]);
    // A split continues the source, so the caption runs (and the captions) don't change.
    expect(captionRuns(after)).toEqual(captionRuns(document));
  });

  it("zooms each item a range spans, and leaves the cuts as they were", () => {
    const document = edit([
      [0, 60, 0],
      [60, 60, 100],
      [120, 60, 200],
    ]);
    const planned = zoomOps(document, [{ start: 30, end: 150 }], zoom);
    const after = applied(document, planned.ops);
    expect(planned.items).toBe(3);
    expect(layout(after)).toEqual([
      { id: "v1", start: 0, duration: 30, zoomed: false },
      { id: "vz1", start: 30, duration: 30, zoomed: true },
      { id: "v2", start: 60, duration: 60, zoomed: true },
      { id: "v3", start: 120, duration: 30, zoomed: true },
      { id: "vz2", start: 150, duration: 30, zoomed: false },
    ]);
    expect(captionRuns(after)).toEqual(captionRuns(document));
  });

  it("needs no split when the range is an item's own", () => {
    const document = edit([
      [0, 60, 0],
      [60, 60, 100],
    ]);
    expect(zoomOps(document, [{ start: 60, end: 120 }], zoom).ops).toEqual([
      { _tag: "setItemProps", itemId: "v2", props: { zoom } },
    ]);
  });

  it("zooms two ranges inside one item, keeping the item's id on its left part", () => {
    const document = edit([[0, 300, 0]]);
    const planned = zoomOps(
      document,
      [
        { start: 20, end: 40 },
        { start: 200, end: 250 },
      ],
      zoom,
    );
    expect(layout(applied(document, planned.ops))).toEqual([
      { id: "v1", start: 0, duration: 20, zoomed: false },
      { id: "vz4", start: 20, duration: 20, zoomed: true },
      { id: "vz3", start: 40, duration: 160, zoomed: false },
      { id: "vz2", start: 200, duration: 50, zoomed: true },
      { id: "vz1", start: 250, duration: 50, zoomed: false },
    ]);
  });
});

describe("parseZoomRange", () => {
  it("reads one clip-frame range, end exclusive, and nothing else", () => {
    expect(parseZoomRange("120-180")).toEqual({ from: 120, to: 180 });
    expect(parseZoomRange(" 0 - 30 ")).toEqual({ from: 0, to: 30 });
    for (const bad of ["9-30,60-90", "60-30", "30-30", "30", "a-b", "-5-10", ""]) {
      expect(parseZoomRange(bad), bad).toBeNull();
    }
  });
});
