// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { EnvironmentId, type MediaAsset, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { ProjectEditState } from "../../editor/editStore";
import type { MediaLibraryState } from "../../state/media";

const state = vi.hoisted(() => ({
  edit: { _tag: "loading" } as ProjectEditState,
  library: { _tag: "loading" } as MediaLibraryState,
}));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjectEdit: () => state.edit,
  useEngineJob: () => null,
}));
vi.mock(import("../../state/media"), () => ({
  useMediaLibrary: () => state.library,
  mediaEnvironment: {} as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../../assets/assetUrls"), () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: "" }) as never,
}));

import "../../index.css";

import EditorPanel from "./EditorPanel";

const FPS = { num: 30, den: 1 };
const projectId = ProjectId.make("project-1");

const asset = (id: string, overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  kind: "video",
  label: `${id}.mov`,
  storage: "reference",
  location: `/Users/me/Movies/${id}.mov`,
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

const setState = (items: ReadonlyArray<MediaAsset>, cut: boolean) => {
  state.library = { _tag: "ready", snapshot: { projectId, fps: FPS, items, importing: [] } };
  state.edit = {
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
        tracks: cut
          ? [
              {
                kind: "video",
                id: "v1",
                items: [{ id: "a", media: "clip-0", start: 0, duration: 30, in: 10 }],
              },
            ]
          : [],
        markers: [],
        metadata: {},
      },
    },
  };
};

const sized = () => {
  const container = document.createElement("div");
  container.style.height = "760px";
  container.style.width = "420px";
  return container;
};

const renderPanel = () =>
  render(<EditorPanel environmentId={EnvironmentId.make("env-1")} projectId={projectId} />, {
    container: sized(),
    router: false,
  });

describe("EditorPanel", () => {
  it("should handle an empty edit: invites a drop and runs no player", async () => {
    setState([], false);
    await using screen = await renderPanel();
    await expect.element(screen.getByText("Drop a clip here or into the chat.")).toBeVisible();
    expect(document.querySelector("video")).toBeNull();
  });

  it("should handle missing media with Find file…", async () => {
    setState([asset("clip-0", { state: "missing" })], true);
    await using screen = await renderPanel();
    await expect.element(screen.getByText("Clip not found")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Find file…" })).toBeVisible();
  });

  it("plays the edit with Export in the header", async () => {
    setState([asset("clip-0")], true);
    await using screen = await renderPanel();
    await expect.element(screen.getByRole("group", { name: "Player: clip-0.mov" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("keeps each tab's scroll position when switching tabs", async () => {
    setState(
      Array.from({ length: 40 }, (_, index) => asset(`clip-${index}`)),
      true,
    );
    await using screen = await renderPanel();
    await expect
      .element(screen.getByRole("tab", { name: "Assets" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByRole("listitem", { name: /^clip-0\.mov/u })).toBeVisible();
    const panel = document.getElementById("editor-tabpanel-assets")!;
    const scroller = [...panel.querySelectorAll<HTMLElement>("*")].find(
      (element) =>
        element.scrollHeight > element.clientHeight + 100 &&
        ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
    )!;
    await act(() => {
      scroller.scrollTop = 600;
    });
    const scrolled = scroller.scrollTop;
    expect(scrolled).toBeGreaterThan(0);

    await screen.getByRole("tab", { name: "Transcript" }).click();
    await expect.element(screen.getByRole("tabpanel", { name: "Transcript" })).toBeVisible();
    expect(document.getElementById("editor-tabpanel-assets")!.hidden).toBe(true);
    await screen.getByRole("tab", { name: "Assets" }).click();
    await expect
      .element(screen.getByRole("tab", { name: "Assets" }))
      .toHaveAttribute("aria-selected", "true");
    expect(scroller.isConnected).toBe(true);
    expect(scroller.scrollTop).toBe(scrolled);
  });
});
