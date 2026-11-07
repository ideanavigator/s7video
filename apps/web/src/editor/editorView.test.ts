// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { type EditDocument, type MediaAsset, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MediaLibraryState } from "../state/media";
import type { ProjectEditState } from "./editStore";
import { playerViewOf } from "./editorView";

const FPS = { num: 30, den: 1 };

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: "clip",
  kind: "video",
  label: "interview.mov",
  storage: "reference",
  location: "/Users/me/Movies/interview.mov",
  state: "ready",
  sizeBytes: 1_000,
  durationFrames: 300,
  fps: FPS,
  hasVideo: true,
  hasAudio: true,
  hasThumbnail: true,
  proxy: { status: "none" },
  ...overrides,
});

const library = (items: ReadonlyArray<MediaAsset>): MediaLibraryState => ({
  _tag: "ready",
  snapshot: { projectId: ProjectId.make("project-1"), fps: FPS, items, importing: [] },
});

const edit = (tracks: EditDocument["tracks"]): ProjectEditState => ({
  _tag: "ready",
  snapshot: {
    revision: 1,
    canUndo: false,
    canRedo: false,
    document: {
      version: 1,
      fps: FPS,
      canvas: { width: 1920, height: 1080 },
      media: [],
      tracks,
      markers: [],
      metadata: {},
    },
  },
});

const cut = edit([
  {
    kind: "video",
    id: "v1",
    items: [
      { id: "a", media: "clip", start: 0, duration: 30, in: 0 },
      { id: "b", media: "clip", start: 30, duration: 30, in: 90 },
    ],
  },
]);

const EDIT = { kind: "edit" } as const;

describe("playerViewOf", () => {
  it("should handle an empty edit", () => {
    expect(playerViewOf(edit([]), library([]), EDIT)).toEqual({ _tag: "empty" });
  });

  it("previews the first clip whole before anything is on the timeline", () => {
    const view = playerViewOf(edit([]), library([asset()]), EDIT);
    expect(view).toMatchObject({ _tag: "play", mode: "clip", variant: "original" });
  });

  it("plays the cut from the proxy once it is ready", () => {
    const view = playerViewOf(cut, library([asset({ proxy: { status: "ready" } })]), EDIT);
    expect(view).toMatchObject({ _tag: "play", mode: "edit", variant: "proxy" });
    expect(view._tag === "play" && view.plan.segments).toHaveLength(2);
  });

  it("should handle missing media", () => {
    const view = playerViewOf(cut, library([asset({ state: "missing" })]), EDIT);
    expect(view).toMatchObject({ _tag: "missing", asset: { id: "clip" } });
  });

  it("should handle every range removed", () => {
    const allCut = edit([{ kind: "video", id: "v1", items: [] }]);
    expect(playerViewOf(allCut, library([asset()]), EDIT)).toEqual({ _tag: "all-cut" });
  });

  it("plays a clip picked in Assets, and the edit when that clip is gone", () => {
    const other = asset({ id: "broll", label: "broll.mov" });
    expect(
      playerViewOf(cut, library([asset(), other]), { kind: "clip", mediaId: "broll" }),
    ).toMatchObject({ _tag: "play", mode: "clip", asset: { id: "broll" } });
    expect(playerViewOf(cut, library([asset()]), { kind: "clip", mediaId: "broll" })).toMatchObject(
      { _tag: "play", mode: "edit" },
    );
  });

  it("waits for both the edit and the media, and says when either can't be read", () => {
    expect(playerViewOf({ _tag: "loading" }, library([]), EDIT)).toEqual({ _tag: "loading" });
    expect(playerViewOf(cut, { _tag: "loading" }, EDIT)).toEqual({ _tag: "loading" });
    expect(
      playerViewOf({ _tag: "unavailable", message: "Not a video project." }, library([]), EDIT),
    ).toEqual({ _tag: "unavailable", message: "Not a video project." });
    expect(playerViewOf(cut, { _tag: "unavailable" }, EDIT)._tag).toBe("unavailable");
  });

  it("should pick EditPlayer for one source and MultiClipPlayer for several", () => {
    const media = library([asset(), asset({ id: "broll", label: "broll.mov" })]);
    expect(playerViewOf(cut, media, EDIT)._tag).toBe("play");
    const layouts: ReadonlyArray<EditDocument["tracks"][number]["items"]> = [
      // Two sources.
      [
        { id: "a", media: "clip", start: 0, duration: 30, in: 0 },
        { id: "b", media: "broll", start: 30, duration: 30, in: 0 },
      ],
      // One source with a gap.
      [
        { id: "a", media: "clip", start: 0, duration: 30, in: 0 },
        { id: "b", media: "clip", start: 45, duration: 30, in: 90 },
      ],
      // One source, reordered.
      [
        { id: "a", media: "clip", start: 0, duration: 30, in: 90 },
        { id: "b", media: "clip", start: 30, duration: 30, in: 0 },
      ],
    ];
    for (const items of layouts) {
      const view = playerViewOf(edit([{ kind: "video", id: "v1", items }] as never), media, EDIT);
      expect(view._tag).toBe("play-timeline");
    }
    const view = playerViewOf(
      edit([{ kind: "video", id: "v1", items: layouts[0]! }] as never),
      library([asset({ proxy: { status: "ready" } })]),
      EDIT,
    );
    expect(view).toMatchObject({
      _tag: "play-timeline",
      sources: [
        { mediaId: "clip", asset: { id: "clip" }, label: "interview.mov", variant: "proxy" },
        { mediaId: "broll", asset: undefined, label: "a clip", variant: "original" },
      ],
    });
  });

  it("names a clip the library lacks by the file the edit records, never its id", () => {
    const base = edit([
      {
        kind: "video",
        id: "v1",
        items: [
          { id: "a", media: "clip", start: 0, duration: 30, in: 0 },
          { id: "b", media: "m-7f3a", start: 30, duration: 30, in: 0 },
        ],
      },
    ] as never);
    if (base._tag !== "ready") throw new Error("edit not ready");
    const withMedia: ProjectEditState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        document: {
          ...base.snapshot.document,
          media: [{ id: "m-7f3a", kind: "video", path: "assets/Beach take 2.mov" } as never],
        },
      },
    };
    const view = playerViewOf(withMedia, library([asset()]), EDIT);
    expect(view._tag === "play-timeline" && view.sources[1]!.label).toBe("Beach take 2.mov");
  });
});
