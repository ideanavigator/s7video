// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** S7V-093: the one rule silence removal and video_assemble share for the clip's video track. */
import { type EditDocument, type EditTrack, emptyEditDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { firstClipCanvasOps, videoTrackFor } from "./videoTrack.ts";

const clip = (id: string, width?: number, height?: number) => ({
  id,
  kind: "video" as const,
  path: `assets/${id}.mp4`,
  fingerprint: { sha256: "ab".repeat(32), size: 10 },
  probe: {
    durationFrames: 300,
    hasVideo: true,
    hasAudio: true,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  },
});

const documentWith = (tracks: ReadonlyArray<EditTrack>): EditDocument => ({
  ...emptyEditDocument({ fps: { num: 30, den: 1 }, canvas: { width: 1080, height: 1920 } }),
  media: [clip("cam"), clip("broll")],
  tracks: [...tracks],
});

const item = (id: string, media: string, start: number) => ({
  id,
  media,
  start,
  duration: 30,
  in: 0,
});

describe("videoTrackFor", () => {
  it("picks the video track holding the clip, else the first video track", () => {
    const document = documentWith([
      { kind: "music", id: "M1", items: [] },
      { kind: "video", id: "V1", items: [item("a", "cam", 0)] },
      { kind: "video", id: "V2", items: [item("b", "broll", 0)] },
    ]);
    expect(videoTrackFor(document, "broll")).toMatchObject({ trackId: "V2", addTrack: [] });
    expect(videoTrackFor(document, "other")).toMatchObject({ trackId: "V1", addTrack: [] });
    expect(videoTrackFor(document)).toMatchObject({ trackId: "V1", addTrack: [] });
  });

  it("adds the first free V<n> when the edit has no video track", () => {
    expect(videoTrackFor(documentWith([]), "cam")).toEqual({
      trackId: "V1",
      items: [],
      addTrack: [{ _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } }],
    });
    // Ids share one space across the edit, so an item called V1 is skipped too.
    const taken = documentWith([
      { kind: "sfx", id: "V1", items: [] },
      { kind: "music", id: "M1", items: [{ ...item("V2", "cam", 0), gainDb: 0 }] },
    ]);
    expect(videoTrackFor(taken).trackId).toBe("V3");
  });
});

describe("firstClipCanvasOps", () => {
  const wide = clip("cam", 1920, 1080);

  it("gives an edit with no video the first clip's shape", () => {
    expect(firstClipCanvasOps(documentWith([]), wide)).toEqual([
      { _tag: "setCanvas", canvas: { width: 1920, height: 1080 }, fromClip: true },
    ]);
  });

  it("leaves the shape when video is placed, the user chose one, or it already matches", () => {
    const placed = documentWith([{ kind: "video", id: "V1", items: [item("a", "cam", 0)] }]);
    const chosen = { ...documentWith([]), metadata: { canvasChosen: true } };
    expect(firstClipCanvasOps(placed, wide)).toEqual([]);
    expect(firstClipCanvasOps(chosen, wide)).toEqual([]);
    expect(firstClipCanvasOps(documentWith([]), clip("cam", 1080, 1920))).toEqual([]);
    expect(firstClipCanvasOps(documentWith([]), clip("cam"))).toEqual([]);
  });
});
