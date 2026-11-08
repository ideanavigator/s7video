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
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";

import {
  type ProjectEditState,
  type ProjectExport,
  subscribePlayerSeek,
  useEditPlayerStore,
} from "../../editor/editStore";
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
  historyClean: vi.fn(),
  historyDismiss: vi.fn(),
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
  // The Versions tab (S7V-069) has its own tests; here it stays loading.
  useProjectVersions: () => ({ _tag: "loading" }),
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
        : command?.label.endsWith("edit:history-clean")
          ? commands.historyClean
          : command?.label.endsWith("edit:history-dismiss")
            ? commands.historyDismiss
            : vi.fn()) as never,
}));
vi.mock(import("../../assets/assetUrls"), () => ({
  useAssetUrlState: ((
    _environmentId: unknown,
    resource: { readonly variant?: string } | null,
    revision?: string | null,
  ) => {
    // Only the player's source counts: Assets thumbnails render on their own schedule.
    if (resource !== null && resource.variant !== "thumbnail") {
      state.urlRevisions.push(revision);
      state.urlVariants.push(resource.variant);
    }
    return { _tag: "Success", url: "" };
  }) as never,
  // The timeline's waveforms and filmstrips (S7V-035) mint part URLs; none are served here.
  useAssetUrlMinter: () => async () => null,
}));

import "../../index.css";

import { BROWSER_ADD_MEDIA_HINT } from "./addMediaHint";
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

/** The Assets tab's scrolling list; needs enough clips to overflow. */
const assetsScroller = () =>
  [...document.getElementById("editor-tabpanel-assets")!.querySelectorAll<HTMLElement>("*")].find(
    (element) =>
      element.scrollHeight > element.clientHeight + 100 &&
      ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
  )!;

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
    window.desktopBridge = {} as NonNullable<typeof window.desktopBridge>;
    try {
      await using screen = await renderPanel();
      await expect.element(screen.getByText("Drop a clip here or into the chat.")).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Add media" }).first()).toBeEnabled();
      expect(screen.getByText(BROWSER_ADD_MEDIA_HINT).query()).toBeNull();
      expect(document.querySelector("video")).toBeNull();
    } finally {
      delete window.desktopBridge;
    }
  });

  it("the empty player explains how to add a clip in the browser", async () => {
    setState([], false);
    await using screen = await renderPanel();
    const player = screen.getByText("No clips yet").first().element().closest("[data-slot=empty]");
    expect(player).not.toBeNull();
    const button = page.elementLocator(player!).getByRole("button", { name: "Add media" });
    await expect.element(button).toBeDisabled();
    await expect.element(button).toHaveAccessibleDescription(BROWSER_ADD_MEDIA_HINT);
    expect(screen.getByText("Drop a clip here", { exact: false }).query()).toBeNull();
    // The player and the Assets tab each say it once.
    const assets = page.elementLocator(document.getElementById("editor-tabpanel-assets")!);
    expect(assets.getByText(BROWSER_ADD_MEDIA_HINT).elements()).toHaveLength(1);
    await expect
      .element(assets.getByRole("button", { name: "Add media" }))
      .toHaveAccessibleDescription(BROWSER_ADD_MEDIA_HINT);
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

  // S7V-054: an outside change that was not kept says why, once, over the restored edit.
  it("shows the refusal notice once, then plays the restored edit", async () => {
    setState([asset("clip-0")], true);
    const ready = state.edit as Extract<ProjectEditState, { _tag: "ready" }>;
    const notice = "That change was not kept; the edit is back to its last saved version.";
    state.edit = { _tag: "ready", snapshot: { ...ready.snapshot, notice } };
    await using screen = await renderPanel();
    await expect.element(screen.getByRole("status").filter({ hasText: notice })).toBeVisible();
    await expect.element(screen.getByRole("group", { name: "Player: clip-0.mov" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText(notice).query()).toBeNull();
    // The next change brings no notice; a later refusal shows its own.
    state.edit = { _tag: "ready", snapshot: { ...ready.snapshot, revision: 2 } };
    await screen.rerender(panel());
    expect(screen.getByText(notice).query()).toBeNull();
    state.edit = { _tag: "ready", snapshot: { ...ready.snapshot, revision: 2, notice } };
    await screen.rerender(panel());
    await expect.element(screen.getByText(notice)).toBeVisible();
  });

  describe("history cleanup banner (S7V-050)", () => {
    const environmentId = EnvironmentId.make("env-1");
    const withCleanup = (cleanup?: { versions: number; bytes: number }) => {
      setState([asset("clip-0")], true);
      const ready = state.edit as Extract<ProjectEditState, { _tag: "ready" }>;
      const { cleanup: _old, ...snapshot } = ready.snapshot;
      state.edit = {
        _tag: "ready",
        snapshot: cleanup === undefined ? snapshot : { ...snapshot, cleanup },
      };
    };
    const banner = (screen: Awaited<ReturnType<typeof renderPanel>>) =>
      screen.getByRole("region", { name: "Old versions" });

    it("shows nothing below the limit", async () => {
      withCleanup();
      await using screen = await renderPanel();
      await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
      expect(banner(screen).query()).toBeNull();
    });

    it("asks with the count and size; Keep recent and Not now call their RPCs", async () => {
      withCleanup({ versions: 62, bytes: 18.04 * 1024 * 1024 });
      toasts.add.mockReset();
      commands.historyClean.mockReset();
      commands.historyClean.mockResolvedValueOnce({
        _tag: "Success",
        value: { removedVersions: 40, removedSteps: 40, freedBytes: 12 * 1024 * 1024 },
      });
      commands.historyDismiss.mockReset();
      commands.historyDismiss.mockResolvedValueOnce({ _tag: "Success", value: {} });
      await using screen = await renderPanel();
      await expect
        .element(
          banner(screen).getByText(
            "This project has 62 saved versions (18.0 MB). Keep only the last 20 (plus tagged and exported ones), or remove all old versions?",
          ),
        )
        .toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Keep recent" }));
      expect(commands.historyClean).toHaveBeenCalledWith({
        environmentId,
        input: { projectId, mode: "keep-recent" },
      });
      await vi.waitFor(() =>
        expect(toasts.add).toHaveBeenCalledWith({
          type: "success",
          title: "Removed 40 old versions",
          description: "Freed 12.0 MB. Your clips are not touched.",
        }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(commands.historyDismiss).toHaveBeenCalledWith({ environmentId, input: { projectId } });
      // The server's next snapshot has no cleanup: the banner goes.
      withCleanup();
      await screen.rerender(panel());
      expect(banner(screen).query()).toBeNull();
    });

    it("Remove all says what it frees first and removes only after confirming", async () => {
      withCleanup({ versions: 62, bytes: 18 * 1024 * 1024 });
      toasts.add.mockReset();
      commands.historyClean.mockReset();
      commands.historyClean
        .mockResolvedValueOnce({
          _tag: "Success",
          value: { removedVersions: 61, removedSteps: 61, freedBytes: 17.5 * 1024 * 1024 },
        })
        .mockResolvedValueOnce({
          _tag: "Success",
          value: { removedVersions: 61, removedSteps: 61, freedBytes: 17.5 * 1024 * 1024 },
        });
      await using screen = await renderPanel();
      await userEvent.click(screen.getByRole("button", { name: "Remove all old versions" }));
      expect(commands.historyClean).toHaveBeenCalledWith({
        environmentId,
        input: { projectId, mode: "remove-all", dryRun: true },
      });
      const dialog = screen.getByRole("alertdialog");
      await expect
        .element(
          dialog.getByText(
            "This frees 17.5 MB. The current edit and your tagged and exported versions are kept. Undo will start again from now. Your clips are not touched.",
          ),
        )
        .toBeVisible();
      // Cancel removes nothing.
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await expect.element(dialog).not.toBeInTheDocument();
      expect(commands.historyClean).toHaveBeenCalledTimes(1);

      commands.historyClean.mockResolvedValueOnce({
        _tag: "Success",
        value: { removedVersions: 61, removedSteps: 61, freedBytes: 17.5 * 1024 * 1024 },
      });
      await userEvent.click(screen.getByRole("button", { name: "Remove all old versions" }));
      await userEvent.click(screen.getByRole("button", { name: "Remove all", exact: true }));
      expect(commands.historyClean).toHaveBeenLastCalledWith({
        environmentId,
        input: { projectId, mode: "remove-all" },
      });
      await vi.waitFor(() =>
        expect(toasts.add).toHaveBeenCalledWith({
          type: "success",
          title: "Removed all old versions",
          description: "Freed 17.5 MB. Undo starts again from now.",
        }),
      );
    });

    it("the buttons are reachable from the keyboard", async () => {
      withCleanup({ versions: 51, bytes: 1024 * 1024 });
      commands.historyDismiss.mockReset();
      commands.historyDismiss.mockResolvedValueOnce({ _tag: "Success", value: {} });
      await using screen = await renderPanel();
      const notNow = screen.getByRole("button", { name: "Not now" });
      (await notNow.findElement()).focus();
      await userEvent.keyboard("{Enter}");
      expect(commands.historyDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("plays the edit with Export in the header", async () => {
    setState([asset("clip-0")], true);
    await using screen = await renderPanel();
    await expect.element(screen.getByRole("group", { name: "Player: clip-0.mov" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("plays an edit from several clips on the player clock, each clip with its own state", async () => {
    setState([asset("clip-0"), asset("clip-1", { state: "missing" })], true);
    const edit = state.edit;
    if (edit._tag !== "ready") throw new Error("edit not ready");
    state.edit = {
      ...edit,
      snapshot: {
        ...edit.snapshot,
        document: {
          ...edit.snapshot.document,
          tracks: [
            {
              kind: "video",
              id: "v1",
              items: [
                { id: "a", media: "clip-0", start: 0, duration: 30, in: 10 },
                { id: "b", media: "clip-1", start: 45, duration: 30, in: 0 },
              ],
            },
          ],
        },
      },
    };
    state.transcriptMedia = [];
    const projectKey = scopedProjectKey({ environmentId: EnvironmentId.make("env-1"), projectId });
    const seeks: number[] = [];
    const stop = subscribePlayerSeek(projectKey, (frame) => seeks.push(frame));
    try {
      await using screen = await renderPanel();
      await expect
        .element(screen.getByRole("group", { name: "Player: clip-0.mov and 1 more" }))
        .toBeVisible();
      await expect.element(screen.getByTestId("multi-clip-stage")).toBeInTheDocument();
      await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
      expect(document.body.textContent).not.toContain("later version");
      expect(state.transcriptMedia.at(-1)).toBe("clip-0");

      // A click on the second clip seeks the player there; its clip is missing.
      const ruler = document.querySelector<HTMLElement>("[data-timeline-ruler]")!;
      const scroller = document.querySelector<HTMLElement>("[data-testid=timeline-scroller]")!;
      const ppf = Number(scroller.dataset.pxPerFrame);
      await userEvent.click(ruler, { position: { x: 60.5 * ppf, y: 10 } });
      expect(seeks.at(-1)).toBe(60);
      await expect.element(screen.getByText("Clip not found: clip-1.mov")).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Find file…" })).toBeVisible();
      // The Transcript tab follows the playhead into the other clip.
      await expect.poll(() => state.transcriptMedia.at(-1)).toBe("clip-1");
    } finally {
      stop();
    }
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
    const scroller = assetsScroller();
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
    setState(
      Array.from({ length: 40 }, (_, index) => asset(`clip-${index}`)),
      true,
    );
    state.urlRevisions = [];
    await using screen = await renderPanel();
    await act(async () => (await videoOf(screen)).dispatchEvent(new Event("error")));
    // Assets rows that render after the retry (a busy machine, a scroll) must not hide it.
    const list = assetsScroller();
    await act(() => {
      list.scrollTop = list.scrollHeight;
    });
    await expect.element(screen.getByRole("listitem", { name: /^clip-39\.mov/u })).toBeVisible();
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

  it("shows the edit on a timeline under the player, and a click there seeks the player", async () => {
    setState([asset("clip-0")], true);
    const projectKey = scopedProjectKey({ environmentId: EnvironmentId.make("env-1"), projectId });
    const seeks: number[] = [];
    const stop = subscribePlayerSeek(projectKey, (frame) => seeks.push(frame));
    try {
      await using screen = await renderPanel();
      const timeline = screen.getByRole("region", { name: "Timeline" });
      await expect.element(timeline).toBeVisible();
      for (const kind of ["Overlays", "Video", "Captions", "Sound effects", "Music"]) {
        await expect
          .element(timeline.getByRole("list", { name: new RegExp(`^${kind} track`) }))
          .toBeInTheDocument();
      }
      await expect
        .element(timeline.getByRole("listitem", { name: /^a, from 0:00/u }))
        .toBeVisible();
      const ruler = document.querySelector<HTMLElement>("[data-timeline-ruler]")!;
      const scroller = document.querySelector<HTMLElement>("[data-testid=timeline-scroller]")!;
      const ppf = Number(scroller.dataset.pxPerFrame);
      await userEvent.click(ruler, { position: { x: 12.5 * ppf, y: 10 } });
      expect(seeks.at(-1)).toBe(12);
    } finally {
      stop();
    }
  });

  it("hides the timeline playhead while a clip previews, and a click goes back to the edit", async () => {
    setState([asset("clip-0")], true);
    const projectKey = scopedProjectKey({ environmentId: EnvironmentId.make("env-1"), projectId });
    useEditPlayerStore.getState().setSource(projectKey, { kind: "clip", mediaId: "clip-0" });
    await using screen = await renderPanel();
    await expect.element(screen.getByText("Clip: clip-0.mov")).toBeVisible();
    const playhead = document.querySelector<HTMLElement>("[data-testid=timeline-playhead]")!;
    await expect.poll(() => playhead.hidden).toBe(true);
    const ruler = document.querySelector<HTMLElement>("[data-timeline-ruler]")!;
    await userEvent.click(ruler, { position: { x: 30, y: 10 } });
    await expect.element(screen.getByText("Clip: clip-0.mov")).not.toBeInTheDocument();
    expect(useEditPlayerStore.getState().sourceByProjectKey[projectKey]).toEqual({ kind: "edit" });
    await expect.poll(() => playhead.hidden).toBe(false);
  });

  it("previews a version read only, with a bar back to the current edit", async () => {
    setState([asset("clip-0")], true);
    const projectKey = scopedProjectKey({ environmentId: EnvironmentId.make("env-1"), projectId });
    if (state.edit._tag !== "ready") throw new Error("edit not ready");
    const older = {
      ...state.edit.snapshot.document,
      tracks: [
        {
          kind: "video" as const,
          id: "v1",
          items: [{ id: "a", media: "clip-0", start: 0, duration: 90, in: 0 }],
        },
      ],
    };
    useEditPlayerStore.getState().setSource(projectKey, { kind: "version", n: 2, document: older });
    await using screen = await renderPanel();
    await expect.element(screen.getByRole("status").getByText("Previewing v2")).toBeVisible();
    await expect.element(await videoOf(screen)).toBeInTheDocument();
    // Export would write the current edit, so it waits until the preview ends.
    expect(screen.getByRole("button", { name: "Export" }).query()).toBeNull();
    const playhead = document.querySelector<HTMLElement>("[data-testid=timeline-playhead]")!;
    await expect.poll(() => playhead.hidden).toBe(true);
    await screen.getByRole("button", { name: "Back to current" }).click();
    expect(useEditPlayerStore.getState().sourceByProjectKey[projectKey]).toEqual({ kind: "edit" });
    await expect.element(screen.getByText("Previewing v2")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
    expect(commands.start).not.toHaveBeenCalled();
  });
});
