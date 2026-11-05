// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EngineJobId,
  type EngineJob,
  EnvironmentId,
  type MediaAsset,
  ProjectId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { ProjectEditState, ProjectExport } from "../../editor/editStore";
import type { MediaLibraryState } from "../../state/media";

const state = vi.hoisted(() => ({
  edit: { _tag: "loading" } as ProjectEditState,
  library: { _tag: "loading" } as MediaLibraryState,
  export: { job: null, status: null } as ProjectExport,
  urlRevisions: [] as Array<string | null | undefined>,
}));

/** The export as the jobs stream would deliver it: setting it re-renders its readers. */
const exportStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: ProjectExport) => {
      state.export = next;
      for (const listener of listeners) listener();
    },
  };
});

const commands = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(async () => ({ _tag: "Success", value: { applied: true } })),
}));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjectEdit: () => state.edit,
  useProjectExport: () => useSyncExternalStore(exportStore.subscribe, () => state.export),
}));
vi.mock(import("../../state/media"), () => ({
  useMediaLibrary: () => state.library,
  mediaEnvironment: {} as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string } | undefined) =>
    command?.label.endsWith("export:start")
      ? commands.start
      : command?.label.endsWith("engine:cancel")
        ? commands.cancel
        : vi.fn()) as never,
}));
vi.mock(import("../../assets/assetUrls"), () => ({
  useAssetUrlState: ((_environmentId: unknown, _resource: unknown, revision?: string | null) => {
    state.urlRevisions.push(revision);
    return { _tag: "Success", url: "" };
  }) as never,
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

const exportJob = (overrides: Partial<EngineJob> = {}): EngineJob => ({
  id: EngineJobId.make("job-1"),
  kind: "export",
  progress: 0.4,
  stage: "render",
  state: "running",
  projectId,
  ...overrides,
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

  it("cancels a running export and says it was cancelled", async () => {
    setState([asset("clip-0")], true);
    state.export = { job: exportJob(), status: null };
    await using screen = await renderPanel();
    await expect
      .element(screen.getByRole("progressbar", { name: "Export" }))
      .toHaveAttribute("aria-valuenow", "40");
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(commands.cancel).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: { jobId: "job-1" },
    });

    await act(() => exportStore.set({ job: exportJob({ state: "cancelled" }), status: null }));
    await expect.element(screen.getByText("Export cancelled")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("shows the plain reason an export failed", async () => {
    setState([asset("clip-0")], true);
    state.export = {
      job: exportJob({ state: "failed" }),
      status: {
        jobId: EngineJobId.make("job-1"),
        projectId,
        path: "exports/edit.mp4",
        state: "failed",
        message: "The disk is full.",
      },
    };
    await using screen = await renderPanel();
    await expect.element(screen.getByText("Export failed: The disk is full.")).toBeVisible();
    state.export = { job: null, status: null };
  });

  it("retries a video that fails once, then explains and offers Retry", async () => {
    setState([asset("clip-0")], true);
    state.urlRevisions = [];
    await using screen = await renderPanel();
    const fail = async () => {
      const video = (await screen
        .getByLabelText("clip-0.mov", { exact: true })
        .findElement()) as HTMLVideoElement;
      await act(() => video.dispatchEvent(new Event("error")));
    };
    await fail();
    // The quiet retry mints a fresh URL and keeps the player.
    expect(state.urlRevisions.at(-1)).toBe("1");
    await fail();
    await expect.element(screen.getByText("Video unavailable")).toBeVisible();
    expect(document.querySelector("video")).toBeNull();

    await screen.getByRole("button", { name: "Retry" }).click();
    await expect.element(screen.getByLabelText("clip-0.mov", { exact: true })).toBeInTheDocument();
    expect(state.urlRevisions.at(-1)).toBe("2");
  });
});
