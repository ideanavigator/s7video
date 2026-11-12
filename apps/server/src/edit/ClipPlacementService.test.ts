// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** S7V-093: the ops that put clip parts on the timeline (the service applies them as one step). */
import { type EditDocument, emptyEditDocument, validateEditDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";
import { addClipsOps, ClipPlacementError } from "./ClipPlacementService.ts";

const wide = {
  id: "cam",
  kind: "video" as const,
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 10 },
  probe: { durationFrames: 300, hasVideo: true, hasAudio: true, width: 1920, height: 1080 },
};

const newEdit = (chosen: boolean): EditDocument => ({
  ...emptyEditDocument({ fps: { num: 30, den: 1 }, canvas: { width: 1080, height: 1920 } }),
  media: [wide],
  ...(chosen ? { metadata: { canvasChosen: true } } : {}),
});

const applied = (document: EditDocument, revision: number) => {
  const planned = addClipsOps(document, revision, {
    parts: [{ mediaId: "cam", in: 0, duration: 90 }],
  });
  if (planned instanceof ClipPlacementError) throw planned;
  const result = applyEditOps(document, planned.ops);
  if (result._tag !== "applied") throw new Error(result.error.message);
  expect(validateEditDocument(result.document).ok).toBe(true);
  return result.document;
};

describe("addClipsOps on a new project's edit", () => {
  it("adds V1 with the parts and gives the edit the clip's shape", () => {
    const after = applied(newEdit(false), 3);
    expect(after.tracks).toEqual([
      {
        kind: "video",
        id: "V1",
        items: [{ id: "asm3-0", media: "cam", start: 0, duration: 90, in: 0 }],
      },
    ]);
    expect(after.canvas).toEqual({ width: 1920, height: 1080 });
  });

  it("refuses an at past frame 0 with the plain reason", () => {
    const refused = addClipsOps(newEdit(false), 3, {
      parts: [{ mediaId: "cam", in: 0, duration: 90 }],
      at: 30,
    });
    expect(refused).toEqual(
      new ClipPlacementError({
        reason: "bad-at",
        detail: "at must be where a video item starts, or the end of the edit (frame 0).",
      }),
    );
  });
});
