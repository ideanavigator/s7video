// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EngineJobId,
  type EngineJob,
  EnvironmentId,
  ExportStartError,
  type MediaAsset,
  ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
  urlVariants: [] as Array<string | undefined>,
  transcriptMedia: [] as Array<string | null>,
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
const toasts = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock(import("../ui/toast"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, toastManager: { ...actual.toastManager, add: toasts.add } };
});

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjectEdit: () => state.edit,
  useProjectExport: () => useSyncExternalStore(exportStore.subscribe, () => state.export),
  useMediaTranscript: (_ref: unknown, mediaId: string | null) => {
    state.transcriptMedia.push(mediaId);
    return { _tag: "loading" };
  },
  useTranscriptionJobs: () => ({ transcribe: null, download: null }),
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
  useAssetUrlState: ((
    _environmentId: unknown,
    resource: { readonly variant?: string } | null,
    revision?: string | null,
  ) => {
    state.urlRevisions.push(revision);
    if (resource?.variant !== undefined) state.urlVariants.push(resource.variant);
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

const panel = () => (
  <EditorPanel environmentId={EnvironmentId.make("env-1")} projectId={projectId} />
);

const renderPanel = () => render(panel(), { container: sized(), router: false });

const videoOf = async (screen: Awaited<ReturnType<typeof renderPanel>>) =>
  (await screen.getByLabelText("clip-0.mov", { exact: true }).findElement()) as HTMLVideoElement;

const PROXY_READY = { proxy: { status: "ready" } } as const;

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

  it("reads the edit's own clip in the transcript when every part is cut", async () => {
    setState([asset("clip-0"), asset("clip-1")], false);
    const ready = state.edit as Extract<ProjectEditState, { _tag: "ready" }>;
    const document = ready.snapshot.document;
    state.edit = {
      _tag: "ready",
      snapshot: {
        ...ready.snapshot,
        document: {
          ...document,
          media: [
            {
              id: "clip-1",
              kind: "video",
              path: "assets/clip-1.mov",
              fingerprint: { sha256: "1".repeat(64), size: 1_000 },
              probe: {},
            } as unknown as (typeof document.media)[number],
          ],
          tracks: [{ kind: "video", id: "v1", items: [] }],
        },
      },
    };
    state.transcriptMedia = [];
    await using screen = await renderPanel();
    await expect.element(screen.getByText("Everything is cut")).toBeVisible();
    expect(state.transcriptMedia.at(-1)).toBe("clip-1");
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
    const cancel = screen.getByRole("button", { name: "Cancel export" });
    await cancel.click();
    expect(commands.cancel).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: { jobId: "job-1" },
    });
    // Until the job stops, a second click can't resend the cancel.
    await expect.element(cancel).toBeDisabled();

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

  it("offers to export without captions when the clip has no transcript", async () => {
    setState([asset("clip-0")], true);
    toasts.add.mockReset();
    commands.start.mockReset();
    commands.start
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new ExportStartError({ projectId, reason: "no-transcript" })),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { jobId: EngineJobId.make("job-2"), path: "exports/edit.mp4" },
      });
    await using screen = await renderPanel();
    await screen.getByRole("button", { name: "Export" }).click();
    // Captions are on by default: the first request does not turn them off.
    expect(commands.start).toHaveBeenNthCalledWith(1, {
      environmentId: EnvironmentId.make("env-1"),
      input: { projectId },
    });
    await vi.waitFor(() => expect(toasts.add).toHaveBeenCalledTimes(1));
    const toast = toasts.add.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "error",
      title: "Couldn't start the export",
      description: "Transcribe the clip first, or export without captions.",
      actionProps: { children: "Export without captions" },
    });
    await act(async () => toast.actionProps.onClick());
    expect(commands.start).toHaveBeenNthCalledWith(2, {
      environmentId: EnvironmentId.make("env-1"),
      input: { projectId, captions: false },
    });
    await expect.element(screen.getByRole("progressbar", { name: "Export" })).toBeVisible();
  });

  it("offers no export action for other start errors", async () => {
    setState([asset("clip-0")], true);
    toasts.add.mockReset();
    commands.start.mockReset();
    commands.start.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new ExportStartError({ projectId, reason: "exports-folder" })),
    });
    await using screen = await renderPanel();
    await screen.getByRole("button", { name: "Export" }).click();
    await vi.waitFor(() => expect(toasts.add).toHaveBeenCalledTimes(1));
    expect(toasts.add.mock.calls[0]![0].actionProps).toBeUndefined();
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

  it("gives a source that loaded its quiet retry back", async () => {
    setState([asset("clip-0")], true);
    state.urlRevisions = [];
    await using screen = await renderPanel();
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("error")));
    expect(state.urlRevisions.at(-1)).toBe("1");
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("loadeddata")));
    // An hour later the URL expires again: still a quiet retry, not the message.
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("error")));
    expect(state.urlRevisions.at(-1)).toBe("2");
    expect(screen.getByText("Video unavailable").query()).toBeNull();
  });

  it("switches to the proxy at the next pause, not mid-playback", async () => {
    setState([asset("clip-0")], true);
    state.urlVariants = [];
    await using screen = await renderPanel();
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("play")));
    setState([asset("clip-0", PROXY_READY)], true);
    await screen.rerender(panel());
    expect(state.urlVariants.at(-1)).toBe("original");
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("pause")));
    await expect.poll(() => state.urlVariants.at(-1)).toBe("proxy");
  });

  it("plays the proxy once it is ready, after the original failed to decode", async () => {
    setState([asset("clip-0")], true);
    state.urlVariants = [];
    await using screen = await renderPanel();
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("error")));
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("error")));
    await expect.element(screen.getByText("Video unavailable")).toBeVisible();
    setState([asset("clip-0", PROXY_READY)], true);
    await screen.rerender(panel());
    await expect.element(screen.getByLabelText("clip-0.mov", { exact: true })).toBeInTheDocument();
    expect(state.urlVariants.at(-1)).toBe("proxy");
    expect(screen.getByText("Video unavailable").query()).toBeNull();
  });
});
