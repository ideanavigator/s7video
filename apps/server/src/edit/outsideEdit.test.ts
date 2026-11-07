// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- A plain path resolver for a pure function.
import { describe, expect, it } from "@effect/vitest";
import { type EditDocument, type EditMedia, emptyEditDocument } from "@t3tools/contracts";
import * as NodePath from "node:path";

import { newOutsideMedia } from "./outsideEdit.ts";

const ROOT = "/Users/someone/Movies/Project";
const locate = (media: EditMedia) =>
  media.path !== undefined
    ? NodePath.resolve(ROOT, media.path)
    : NodePath.resolve(media.reference!);

const clip = (id: string, location: Pick<EditMedia, "path" | "reference">): EditMedia => ({
  id,
  kind: "video",
  ...location,
  fingerprint: { sha256: "ab".repeat(32), size: 1 },
  probe: { hasVideo: true, hasAudio: true },
});

const withMedia = (...media: ReadonlyArray<EditMedia>): EditDocument => ({
  ...emptyEditDocument({ fps: { num: 30, den: 1 }, canvas: { width: 1080, height: 1920 } }),
  media: [...media],
});

describe("newOutsideMedia", () => {
  const cam = clip("cam", { path: "assets/cam.mov" });
  const memo = clip("memo", { reference: "/Users/someone/Desktop/memo.m4a" });

  it("finds added paths and references", () => {
    expect(newOutsideMedia(withMedia(cam, memo), withMedia(cam, memo), locate)).toEqual([]);
    const desk = clip("desk", { reference: "/Users/someone/Desktop/private.mov" });
    expect(newOutsideMedia(withMedia(cam), withMedia(cam, desk), locate)).toEqual([desk]);
    const copied = clip("copied", { path: "assets/copied.mov" });
    expect(newOutsideMedia(withMedia(cam), withMedia(cam, copied), locate)).toEqual([copied]);
    // A known file under a new id is not a new file.
    expect(newOutsideMedia(withMedia(memo), withMedia({ ...memo, id: "renamed" }), locate)).toEqual(
      [],
    );
  });

  it("treats a file relinked inside the project as the same file", () => {
    const relinked = clip("cam", { reference: `${ROOT}/assets/cam.mov` });
    expect(newOutsideMedia(withMedia(cam), withMedia(relinked), locate)).toEqual([]);
    const dotted = clip("cam", { path: "./assets/../assets/cam.mov" });
    expect(newOutsideMedia(withMedia(cam), withMedia(dotted), locate)).toEqual([]);
  });
});
