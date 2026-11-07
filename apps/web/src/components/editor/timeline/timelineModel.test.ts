// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import empty from "../../../../../../fixtures/edit-documents/01-empty.json";
import engineB from "../../../../../../fixtures/edit-documents/04-engine-b.json";
import { firstItemEndingAfter, timelineModelOf } from "./timelineModel";

const document = engineB as unknown as EditDocument;

describe("timelineModelOf", () => {
  it("keeps every item at its edit.json start and duration, in CapCut row order", () => {
    const model = timelineModelOf(document);
    expect(model.rows.map((row) => [row.kind, row.id])).toEqual([
      ["overlay", "O1"],
      ["overlay", "O2"],
      ["video", "V1"],
      ["caption", "C1"],
      ["sfx", "S1"],
      ["music", "M1"],
    ]);
    const positions = new Map(
      model.rows.flatMap((row) => row.items.map((item) => [item.id, [item.start, item.duration]])),
    );
    for (const track of document.tracks) {
      for (const item of track.items) {
        expect(positions.get(item.id)).toEqual([item.start, item.duration]);
      }
    }
    expect(model.itemCount).toBe(11);
    const ends = document.tracks.flatMap((track) => track.items.map((i) => i.start + i.duration));
    expect(model.durationFrames).toBe(Math.max(...ends));
  });

  it("shows a row for each kind even when the edit has none", () => {
    const model = timelineModelOf(empty as unknown as EditDocument);
    expect(model.rows.map((row) => row.kind)).toEqual([
      "overlay",
      "video",
      "caption",
      "sfx",
      "music",
    ]);
    expect(model.itemCount).toBe(0);
    expect(model.durationFrames).toBe(0);
  });

  it("finds the first item ending after a frame", () => {
    const items = timelineModelOf(document).rows.find((row) => row.kind === "video")!.items;
    expect(firstItemEndingAfter(items, 0)).toBe(0);
    const second = items[1]!;
    expect(firstItemEndingAfter(items, second.start)).toBe(1);
    expect(firstItemEndingAfter(items, 1e9)).toBe(items.length);
  });
});
