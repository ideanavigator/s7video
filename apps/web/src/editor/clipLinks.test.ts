// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type MediaAsset, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { MediaLibraryState } from "../state/media";
import type { ProjectEditState } from "./editStore";

const state = vi.hoisted(() => ({
  edit: { _tag: "loading" } as ProjectEditState,
  library: { _tag: "loading" } as MediaLibraryState,
}));

vi.mock(import("../state/entities"), () => ({
  readThreadShell: (() => ({ projectId: "project-1" })) as never,
  readProject: (() => ({ workspaceRoot: "/Users/me/Videos/Charger" })) as never,
}));
vi.mock(import("../state/media"), () => ({
  readMediaLibrary: () => state.library,
}));
vi.mock(import("./editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  readProjectEdit: () => state.edit,
}));

import { useRightPanelStore, selectActiveRightPanelSurface } from "../rightPanelStore";
import { mediaClipForPath, openMediaLinkInEditor } from "./clipLinks";
import { useEditPlayerStore } from "./editStore";

const FPS = { num: 30, den: 1 };
const ROOT = "/Users/me/Videos/Charger";
const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const projectId = ProjectId.make("project-1");

const asset = (id: string, overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  kind: "video",
  label: `${id}.mov`,
  storage: "copy",
  location: `assets/${id}.mov`,
  state: "ready",
  sizeBytes: 1_000,
  durationFrames: 300,
  fps: FPS,
  hasVideo: true,
  hasAudio: true,
  hasThumbnail: false,
  proxy: { status: "none" },
  ...overrides,
});

const ITEMS = [
  asset("take-1"),
  asset("broll", { storage: "reference", location: "/Users/me/Movies/broll.mov" }),
];

describe("mediaClipForPath", () => {
  it.each([
    ["a copy by its project path", "assets/take-1.mov", "take-1"],
    ["a copy written with ./", "./assets/take-1.mov", "take-1"],
    ["a copy by its absolute path", `${ROOT}/assets/take-1.mov`, "take-1"],
    ["a linked clip by its own path", "/Users/me/Movies/broll.mov", "broll"],
    ["a file that is not in Media", "exports/final.mp4", undefined],
    ["a linked clip's name under the project", "assets/broll.mov", undefined],
    ["a copy's path outside the project", "/elsewhere/assets/take-1.mov", undefined],
  ])("finds %s", (_name, path, id) => {
    expect(mediaClipForPath(ITEMS, path, `${ROOT}/`)?.id).toBe(id);
  });
});

describe("openMediaLinkInEditor", () => {
  const reset = () => {
    useRightPanelStore.setState({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
    });
    useEditPlayerStore.setState({ sourceByProjectKey: {} });
  };

  it("plays a clip that is in Media in the Editor, not the file viewer", () => {
    reset();
    state.edit = { _tag: "ready" } as ProjectEditState;
    state.library = {
      _tag: "ready",
      snapshot: { projectId, fps: FPS, items: ITEMS, importing: [] },
    };
    expect(openMediaLinkInEditor(threadRef, "assets/take-1.mov")).toBe(true);
    const projectKey = scopedProjectKey({ environmentId: threadRef.environmentId, projectId });
    expect(useEditPlayerStore.getState().sourceByProjectKey[projectKey]).toEqual({
      kind: "clip",
      mediaId: "take-1",
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ id: "editor", kind: "editor", projectId: "project-1" });
  });

  it("leaves other files, and projects without an edit, to the file viewer", () => {
    reset();
    state.edit = { _tag: "ready" } as ProjectEditState;
    state.library = {
      _tag: "ready",
      snapshot: { projectId, fps: FPS, items: ITEMS, importing: [] },
    };
    expect(openMediaLinkInEditor(threadRef, "notes.txt")).toBe(false);
    state.edit = { _tag: "unavailable", message: "This project has no edit yet." };
    expect(openMediaLinkInEditor(threadRef, "assets/take-1.mov")).toBe(false);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});
