// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EditConflict,
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
  type MediaTranscriptState,
  type ProjectEditState,
  type ProjectExport,
  type ProjectVersionsState,
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
  transcript: { _tag: "loading" } as MediaTranscriptState,
  versions: { _tag: "loading" } as ProjectVersionsState,
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
  apply: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  plan: vi.fn(),
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
    return state.transcript;
  },
  useTranscriptionJobs: () => ({ transcribe: null, download: null }),
  // The Versions tab (S7V-069) has its own tests; here it stays loading but for screenshots.
  useProjectVersions: () => state.versions,
  // The caption overlay (S7V-075) has its own tests.
  useCaptionStills: () => ({ _tag: "none" }),
}));
vi.mock(import("../../state/media"), () => ({
  useMediaLibrary: () => state.library,
  mediaEnvironment: { plan: { label: "environment-data:media:import-plan" } } as never,
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
            : command?.label.endsWith("edit:apply")
              ? commands.apply
              : command?.label.endsWith("edit:undo")
                ? commands.undo
                : command?.label.endsWith("edit:redo")
                  ? commands.redo
                  : command?.label.endsWith("media:import-plan")
                    ? commands.plan
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
import EditorPanel, { CHANGED_ELSEWHERE_NOTICE, DROP_OVERLAY_TEXT } from "./EditorPanel";

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

/** The Media tab's scrolling list; needs enough clips to overflow. */
const assetsScroller = () =>
  [...document.getElementById("editor-tabpanel-media")!.querySelectorAll<HTMLElement>("*")].find(
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
    // The player and the Media tab each say it once.
    await screen.getByRole("tab", { name: "Media" }).click();
    const assets = page.elementLocator(document.getElementById("editor-tabpanel-media")!);
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
    await screen.getByRole("tab", { name: "Media" }).click();
    await expect
      .element(screen.getByRole("tab", { name: "Media" }))
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
    expect(document.getElementById("editor-tabpanel-media")!.hidden).toBe(true);
    await screen.getByRole("tab", { name: "Media" }).click();
    await expect
      .element(screen.getByRole("tab", { name: "Media" }))
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
    // Media rows that render after the retry (a busy machine, a scroll) must not hide it.
    await screen.getByRole("tab", { name: "Media" }).click();
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

  // S7V-034: timeline edits go through edit.apply (origin timeline) and the toolbar's undo.
  it("splits through edit.apply, undoes from the toolbar, and says when the edit changed", async () => {
    setState([asset("clip-0")], true);
    state.edit =
      state.edit._tag === "ready"
        ? { _tag: "ready", snapshot: { ...state.edit.snapshot, canUndo: true } }
        : state.edit;
    toasts.add.mockReset();
    commands.apply.mockReset();
    commands.undo.mockReset();
    commands.apply.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new EditConflict({ baseRevision: 1, currentRevision: 2 })),
    });
    commands.undo.mockResolvedValueOnce({
      _tag: "Success",
      value: { revision: 2, document: {}, canUndo: false, canRedo: true },
    });
    await using screen = await renderPanel();
    const toolbar = screen.getByRole("toolbar", { name: "Timeline editing" });
    await expect.element(toolbar).toBeVisible();
    const ruler = document.querySelector<HTMLElement>("[data-timeline-ruler]")!;
    const scroller = document.querySelector<HTMLElement>("[data-testid=timeline-scroller]")!;
    const ppf = Number(scroller.dataset.pxPerFrame);
    await userEvent.click(ruler, { position: { x: 12.5 * ppf, y: 10 } });
    await toolbar.getByRole("button", { name: "Split" }).click();
    await vi.waitFor(() =>
      expect(commands.apply).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("env-1"),
        input: {
          projectId,
          baseRevision: 1,
          origin: "timeline",
          ops: [{ _tag: "splitItem", itemId: "a", atFrame: 12 }],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(toasts.add).toHaveBeenCalledWith({ type: "info", title: CHANGED_ELSEWHERE_NOTICE }),
    );
    await toolbar.getByRole("button", { name: "Undo" }).click();
    await vi.waitFor(() =>
      expect(commands.undo).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("env-1"),
        input: { projectId },
      }),
    );
    await expect.element(toolbar.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  // S7V-038: text edits take the same edit.apply path, with origin transcript.
  it("cuts words from the Transcript tab through edit.apply, origin transcript", async () => {
    setState([asset("clip-0")], true);
    const word = (text: string, startFrame: number, endFrame: number) => ({
      text,
      startFrame,
      endFrame,
      confidence: 0.9,
      speaker: "S1",
    });
    state.transcript = {
      _tag: "ready",
      transcript: {
        transcriptVersion: 1,
        mediaFingerprint: { sha256: "0".repeat(64), size: 1 },
        model: "test",
        revision: "test",
        fps: FPS,
        durationFrames: 300,
        words: [word("one", 12, 18), word("two", 22, 28), word("three", 32, 38)],
        createdAt: "2026-11-08T00:00:00Z",
      },
    };
    commands.apply.mockReset();
    commands.apply.mockResolvedValueOnce({
      _tag: "Success",
      value: { revision: 2, document: {}, canUndo: true, canRedo: false },
    });
    try {
      await using screen = await renderPanel();
      await screen.getByRole("tab", { name: "Transcript" }).click();
      const one = screen.getByRole("option", { name: "one" });
      await expect.element(one).toBeVisible();
      await one.click();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}{Delete}");
      // "one" starts the clip: the cut runs from its first frame to "three"'s air.
      await vi.waitFor(() =>
        expect(commands.apply).toHaveBeenCalledWith({
          environmentId: EnvironmentId.make("env-1"),
          input: {
            projectId,
            baseRevision: 1,
            origin: "transcript",
            ops: [
              { _tag: "splitItem", itemId: "a", atFrame: 19, newItemId: "vt1" },
              { _tag: "deleteItem", itemIds: ["a"], ripple: true },
            ],
          },
        }),
      );
    } finally {
      state.transcript = { _tag: "loading" };
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

  it("previews a version read only, with a bar back to the main version", async () => {
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
    await screen.getByRole("button", { name: "Back to main" }).click();
    expect(useEditPlayerStore.getState().sourceByProjectKey[projectKey]).toEqual({ kind: "edit" });
    await expect.element(screen.getByText("Previewing v2")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
    expect(commands.start).not.toHaveBeenCalled();
  });

  // S7V-087: the timeline shows the main edit while vN plays, so it must not edit it.
  it("leaves the timeline read-only while a version previews: no edit, and a press goes back to main", async () => {
    setState([asset("clip-0")], true);
    const projectKey = scopedProjectKey({ environmentId: EnvironmentId.make("env-1"), projectId });
    if (state.edit._tag !== "ready") throw new Error("edit not ready");
    commands.apply.mockReset();
    await using screen = await renderPanel();
    await expect.element(screen.getByRole("toolbar", { name: "Timeline editing" })).toBeVisible();
    const scroller = document.querySelector<HTMLElement>("[data-testid=timeline-scroller]")!;
    const clip = () => document.querySelector<HTMLElement>('[data-timeline-item="a"]')!;
    const at = (frame: number) => {
      const rect = clip().getBoundingClientRect();
      const ppf = Number(scroller.dataset.pxPerFrame);
      return { x: rect.left + frame * ppf, y: rect.top + rect.height / 2 };
    };
    const pointer = (type: string, target: EventTarget, frame: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          button: 0,
          clientX: at(frame).x,
          clientY: at(frame).y,
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
    const key = (name: string) =>
      scroller.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      );
    // Select the clip on the main edit, then preview v2: the selection must not act on main.
    pointer("pointerdown", clip(), 15);
    pointer("pointerup", window.document, 15);
    await expect.poll(() => clip().dataset.selected).toBe("true");
    useEditPlayerStore.getState().setSource(projectKey, {
      kind: "version",
      n: 2,
      document: state.edit.snapshot.document,
    });
    await expect.element(screen.getByRole("status").getByText("Previewing v2")).toBeVisible();
    key("Delete");
    key("Backspace");
    key("s");
    await act(async () => {});
    expect(commands.apply).not.toHaveBeenCalled();
    // A drag on the clip moves nothing; the press goes back to the main edit.
    pointer("pointerdown", clip(), 15);
    for (let frame = 15; frame <= 25; frame++) pointer("pointermove", window.document, frame);
    pointer("pointerup", window.document, 25);
    await act(async () => {});
    expect(commands.apply).not.toHaveBeenCalled();
    expect(useEditPlayerStore.getState().sourceByProjectKey[projectKey]).toEqual({ kind: "edit" });
    await expect.element(screen.getByText("Previewing v2")).not.toBeInTheDocument();
  });

  describe("Versions first, Media last, drop anywhere (S7V-076)", () => {
    /** The desktop app, whose files have paths; each drop test starts with no calls recorded. */
    const withDesktop = () => {
      commands.plan.mockReset();
      toasts.add.mockReset();
      window.desktopBridge = {
        getPathForFile: (file: File) => `/Users/me/Movies/${file.name}`,
      } as unknown as NonNullable<typeof window.desktopBridge>;
      return { [Symbol.dispose]: () => delete window.desktopBridge };
    };
    const drag = async (target: Element, file: File, type: "dragover" | "drop") => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      await act(() => {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      });
    };
    const clip = () => new File(["x"], "take-2.mov", { type: "video/quicktime" });

    it("tabs are Versions, Transcript, Media with Versions first", async () => {
      setState([asset("clip-0")], true);
      await using screen = await renderPanel();
      const tabs = screen.getByRole("tablist", { name: "Editor views" }).getByRole("tab").all();
      expect(tabs.map((tab) => tab.element().textContent)).toEqual([
        "Versions",
        "Transcript",
        "Media",
      ]);
      await expect.element(tabs[0]!).toHaveAttribute("aria-selected", "true");
      await expect.element(screen.getByRole("tabpanel", { name: "Versions" })).toBeVisible();
      expect(document.getElementById("editor-tabpanel-media")!.hidden).toBe(true);
      expect(screen.getByRole("tab", { name: "Assets" }).query()).toBeNull();
    });

    it("drop on the player imports the file, with an overlay while dragging", async () => {
      setState([asset("clip-0")], true);
      using _desktop = withDesktop();
      commands.plan.mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("stop")),
      });
      await using screen = await renderPanel();
      const player = await videoOf(screen);
      await drag(player, clip(), "dragover");
      await expect
        .element(screen.getByText(DROP_OVERLAY_TEXT, { exact: true }).first())
        .toBeVisible();
      await drag(player, clip(), "drop");
      await vi.waitFor(() =>
        expect(commands.plan).toHaveBeenCalledWith({
          environmentId: EnvironmentId.make("env-1"),
          input: { projectId, sourcePaths: ["/Users/me/Movies/take-2.mov"] },
        }),
      );
      expect(screen.getByText(DROP_OVERLAY_TEXT, { exact: true }).query()).toBeNull();
    });

    it("drop on the tabs or the timeline imports the file too", async () => {
      setState([asset("clip-0")], true);
      using _desktop = withDesktop();
      commands.plan.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("stop")) });
      await using screen = await renderPanel();
      await drag(screen.getByRole("tablist", { name: "Editor views" }).element(), clip(), "drop");
      await drag(document.querySelector("[data-timeline-ruler]")!, clip(), "drop");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(2));
    });

    it("a file dropped on the Media list is imported once", async () => {
      setState([], false);
      using _desktop = withDesktop();
      commands.plan.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("stop")) });
      await using screen = await renderPanel();
      await screen.getByRole("tab", { name: "Media" }).click();
      const list = page.elementLocator(document.getElementById("editor-tabpanel-media")!);
      await drag(list.getByText("No clips yet").element(), clip(), "drop");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalled());
      expect(commands.plan).toHaveBeenCalledTimes(1);
    });

    it("drop of a non-media file is refused plainly", async () => {
      setState([asset("clip-0")], true);
      using _desktop = withDesktop();
      await using screen = await renderPanel();
      const notes = new File(["x"], "notes.txt", { type: "text/plain" });
      await drag(screen.getByRole("tablist", { name: "Editor views" }).element(), notes, "drop");
      expect(toasts.add).toHaveBeenCalledWith({
        type: "warning",
        title: "Only video and audio files can be added",
        description: "Not added: notes.txt",
      });
      expect(commands.plan).not.toHaveBeenCalled();
    });

    describe("room for the Versions list in a video project", () => {
      const SHOTS = "../../../../../test-results/S7V-076";
      const at = (minute: number) => Date.UTC(2026, 10, 9, 10, minute);
      const versions: ProjectVersionsState = {
        _tag: "ready",
        versions: [
          {
            n: 6,
            revision: 7,
            at: at(9),
            author: "assistant",
            changes: ["Removed 14.2 s of silence in 26 cuts"],
            current: true,
          },
          ...[5, 4, 3, 2, 1].map((n) => ({
            n,
            revision: n + 1,
            at: at(n),
            author: n % 2 === 0 ? ("you" as const) : ("assistant" as const),
            ...(n === 4 ? { tag: "tight cut" } : {}),
            changes: [n === 2 ? "Added captions" : `Trimmed clip ${n}`],
            current: false,
          })),
        ],
      };
      /** The app's right panel: its tab bar (52 px) over the Editor, at 60% beside the chat. */
      const layout = () =>
        render(
          <div className="flex h-screen w-screen bg-background text-foreground">
            <div className="flex min-w-0 flex-1 items-center justify-center border-r text-sm text-muted-foreground">
              Chat column (stand-in)
            </div>
            <div className="flex h-full flex-col" style={{ width: "60%" }}>
              <div className="flex h-[52px] shrink-0 items-center border-b px-3 text-sm text-muted-foreground">
                Panel tabs (stand-in)
              </div>
              <div className="min-h-0 flex-1">{panel()}</div>
            </div>
          </div>,
          { router: false },
        );
      const inside = (inner: DOMRect, outer: DOMRect) =>
        inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
      /** Version rows shown whole, without scrolling the list. */
      const visibleRows = () => {
        const list = document
          .getElementById("editor-tabpanel-versions")!
          .querySelector<HTMLElement>("[role=list]")!;
        const shown = list.getBoundingClientRect();
        return [...list.querySelectorAll("[role=listitem]")].filter((row) =>
          inside(row.getBoundingClientRect(), shown),
        ).length;
      };
      const timelineTracksShown = () => {
        const timeline = document.querySelector("[data-testid=editor-timeline]")!;
        const box = timeline.getBoundingClientRect();
        const panelBox = document
          .querySelector("[data-testid=editor-panel]")!
          .getBoundingClientRect();
        return (
          inside(box, panelBox) &&
          ["Overlays", "Video", "Captions", "Sound effects", "Music"].every((label) => {
            const element = [...timeline.querySelectorAll("*")].find(
              (node) => node.childElementCount === 0 && node.textContent === label,
            );
            return element !== undefined && inside(element.getBoundingClientRect(), box);
          })
        );
      };

      it.each([
        [1440, 900, 4],
        [1180, 760, 2],
      ] as const)("shows the version rows at %ix%i (at least %i)", async (w, h, rows) => {
        await page.viewport(w, h);
        setState([asset("clip-0")], true);
        state.versions = versions;
        try {
          await using screen = await layout();
          await expect.element(screen.getByText("Main", { exact: true })).toBeVisible();
          await expect.poll(visibleRows).toBeGreaterThanOrEqual(rows);
          expect(timelineTracksShown()).toBe(true);
          // The player letterboxes rather than vanishing.
          const player = (await videoOf(screen)).closest("[role=group]")!;
          expect(player.getBoundingClientRect().height).toBeGreaterThanOrEqual(96);
        } finally {
          state.versions = { _tag: "loading" };
        }
      });

      it.each([
        ["dark", 1440, 900],
        ["light", 1440, 900],
        ["dark", 1180, 760],
        ["light", 1180, 760],
      ] as const)(
        "screenshots: layout, Versions with Main, drop overlay (%s, %i)",
        async (theme, w, h) => {
          await page.viewport(w, h);
          document.documentElement.classList.toggle("dark", theme === "dark");
          setState([asset("clip-0")], true);
          state.versions = versions;
          try {
            using _desktop = withDesktop();
            await using screen = await layout();
            await expect.element(screen.getByText("Main", { exact: true })).toBeVisible();
            await expect
              .element(screen.getByRole("button", { name: "Make main, version 5" }))
              .toBeVisible();
            await page.screenshot({ path: `${SHOTS}/layout-versions-${theme}-${w}.png` });
            await drag(await videoOf(screen), clip(), "dragover");
            await expect
              .element(screen.getByText(DROP_OVERLAY_TEXT, { exact: true }).first())
              .toBeVisible();
            await page.screenshot({ path: `${SHOTS}/drop-overlay-${theme}-${w}.png` });
          } finally {
            state.versions = { _tag: "loading" };
            document.documentElement.classList.remove("dark");
          }
        },
      );
    });
  });
});
