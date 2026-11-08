// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  type EditDocument,
  type EditOp,
  EngineError,
  EngineJobId,
  type EngineJob,
  EnvironmentId,
  ProjectId,
  type Transcript,
  type TranscribeModelsStatus,
  type TranscriptWord,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { Profiler, useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import type { PlaybackSegment } from "../../editor/editPlayback";
import {
  type MediaTranscriptState,
  publishPlayerFrame,
  subscribePlayerSeek,
  type TranscriptionJobs,
} from "../../editor/editStore";
import type { TranscriptPlayback } from "../../editor/transcriptModel";

const state = vi.hoisted(() => ({
  transcript: { _tag: "loading" } as MediaTranscriptState,
  jobs: { transcribe: null, download: null } as TranscriptionJobs,
}));

/** The jobs stream: setting it re-renders its readers. */
const jobsStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: TranscriptionJobs) => {
      state.jobs = next;
      for (const listener of listeners) listener();
    },
  };
});

const commands = vi.hoisted(() => ({
  run: vi.fn(),
  status: vi.fn(),
  download: vi.fn(),
  dismiss: vi.fn(async () => ({ _tag: "Success", value: {} })),
  cancel: vi.fn(async () => ({ _tag: "Success", value: { applied: true } })),
}));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useMediaTranscript: () => state.transcript,
  useTranscriptionJobs: () => useSyncExternalStore(jobsStore.subscribe, () => state.jobs),
}));
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock(import("../../editor/transcriptModel"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    buildTranscriptModel: (...args: Parameters<typeof original.buildTranscriptModel>) => {
      builds.count += 1;
      return original.buildTranscriptModel(...args);
    },
  };
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) => {
    const label = command.label;
    if (label.endsWith("transcribe:run")) return commands.run;
    if (label.endsWith("models-status")) return commands.status;
    if (label.endsWith("models-download")) return commands.download;
    if (label.endsWith("models-dismiss")) return commands.dismiss;
    return commands.cancel;
  }) as never,
}));

import "../../index.css";

import type { EditApplyOutcome } from "./timeline/timelineEditor";
import { TRANSCRIPT_CONFLICT_NOTICE, type TranscriptEditing, TranscriptTab } from "./TranscriptTab";

const FPS = { num: 30, den: 1 };
const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const projectKey = `${environmentId}:${projectId}`;
const projectRef = { environmentId, projectId };

const word = (text: string, startFrame: number, endFrame: number): TranscriptWord => ({
  text,
  startFrame,
  endFrame,
  confidence: 0.9,
  speaker: "S1",
});

const transcriptOf = (words: ReadonlyArray<TranscriptWord>): Transcript => ({
  transcriptVersion: 1,
  mediaFingerprint: { sha256: "0".repeat(64), size: 1 },
  model: "test",
  revision: "test",
  fps: FPS,
  durationFrames: words.at(-1)?.endFrame ?? 0,
  words,
  createdAt: "2026-11-06T00:00:00Z",
});

/** `count` words of 8 frames with 2-frame gaps, and a 2 s pause every 40 words. */
const synthetic = (count: number) => {
  const words: TranscriptWord[] = [];
  let frame = 0;
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && index % 40 === 0) frame += 60;
    words.push(word(`word${index}`, frame, frame + 8));
    frame += 10;
  }
  return words;
};

/** Where `synthetic` puts word `index`. */
const startOf = (index: number) => index * 10 + Math.floor(index / 40) * 60;

const segmentsOf = (ranges: ReadonlyArray<readonly [number, number]>): PlaybackSegment[] => {
  let timeline = 0;
  return ranges.map(([start, end]) => {
    const segment = { sourceStart: start, sourceEnd: end, timelineStart: timeline };
    timeline += end - start;
    return segment;
  });
};

const wholeClip = (frames: number): TranscriptPlayback => ({
  fps: FPS,
  segments: segmentsOf([[0, frames]]),
});

// hello [0,10) there [12,22) silence [24,36) general [40,50) kenobi [52,62)
const SHORT = [
  word("hello", 0, 10),
  word("there", 12, 22),
  word("silence", 24, 36),
  word("general", 40, 50),
  word("kenobi", 52, 62),
];
const SILENCE_CUT = segmentsOf([
  [0, 22],
  [40, 62],
]);

const sized = () => {
  const container = document.createElement("div");
  container.style.height = "320px";
  container.style.width = "420px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  return container;
};

const renderTab = (
  playback: TranscriptPlayback | null,
  options: { readonly onRender?: () => void; readonly editing?: TranscriptEditing } = {},
) => {
  const ui = (next: TranscriptPlayback | null, editing = options.editing) => (
    <Profiler id="transcript" onRender={() => options.onRender?.()}>
      <TranscriptTab projectRef={projectRef} mediaId="clip-0" playback={next} editing={editing} />
    </Profiler>
  );
  return render(ui(playback), { container: sized(), router: false }).then((screen) =>
    Object.assign(screen, {
      setPlayback: (next: TranscriptPlayback | null, editing?: TranscriptEditing) =>
        screen.rerender(ui(next, editing ?? options.editing)),
    }),
  );
};

/** An edit of clip-0 playing `ranges` end to end, at revision `revision`. */
const editOf = (ranges: ReadonlyArray<readonly [number, number]>, frames: number): EditDocument => {
  let start = 0;
  return {
    version: 1,
    fps: FPS,
    canvas: { width: 1080, height: 1920 },
    media: [
      {
        id: "clip-0",
        kind: "video",
        path: "assets/clip.mov",
        fingerprint: { sha256: "ab".repeat(32), size: 1 },
        probe: { durationFrames: frames, hasVideo: true, hasAudio: true },
      },
    ],
    tracks: [
      {
        kind: "video",
        id: "V1",
        items: ranges.map(([from, to], index) => {
          const item = {
            id: `v${index + 1}`,
            media: "clip-0",
            start,
            duration: to - from,
            in: from,
          };
          start += to - from;
          return item;
        }),
      },
    ],
    markers: [],
    metadata: {},
  };
};

const editingOf = (
  ranges: ReadonlyArray<readonly [number, number]>,
  frames: number,
  outcome: EditApplyOutcome = { _tag: "applied", revision: 8 },
) => {
  const apply = vi.fn(
    async (_ops: ReadonlyArray<EditOp>, _baseRevision: number): Promise<EditApplyOutcome> =>
      outcome,
  );
  return { editing: { document: editOf(ranges, frames), revision: 7, apply }, apply };
};

/** Presses on word `from`, moves over word `to` and lets go, as a mouse drag does. */
const dragAcross = (from: string, to: string) => {
  const options = { bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1 };
  const start = wordElement(from)!;
  const end = wordElement(to)!;
  start.dispatchEvent(new PointerEvent("pointerdown", options));
  start.closest<HTMLElement>('[role="listbox"]')!.focus();
  end.dispatchEvent(new PointerEvent("pointermove", options));
  end.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0 }));
  end.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
};

const selectedWords = () =>
  [...document.querySelectorAll<HTMLElement>("[data-selected]")].map(
    (element) => element.firstChild?.textContent,
  );

const listenForSeeks = () => {
  const seeks: number[] = [];
  const stop = subscribePlayerSeek(projectKey, (frame) => seeks.push(frame));
  return { seeks, [Symbol.dispose]: stop };
};

const wordElement = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-word]")].find(
    (element) => element.firstChild?.textContent === text,
  ) ?? null;

const currentWords = () =>
  [...document.querySelectorAll<HTMLElement>("[data-current]")].map(
    (element) => element.firstChild?.textContent,
  );

const scroller = (screen: { container: HTMLElement }) => {
  const listbox = screen.container.querySelector<HTMLElement>('[role="listbox"]')!;
  return [...listbox.querySelectorAll<HTMLElement>("*")].find(
    (element) =>
      element.scrollHeight > element.clientHeight + 1 &&
      getComputedStyle(element).overflowY !== "visible",
  )!;
};

const ready = (words: ReadonlyArray<TranscriptWord>) => {
  state.transcript = { _tag: "ready", transcript: transcriptOf(words) };
};

const modelsStatus = (
  ready: boolean,
  recommended: "default" | "light",
): TranscribeModelsStatus => ({
  profiles: {
    default: { sizeBytes: 3_744_329_895, downloadedBytes: 0, ready },
    light: { sizeBytes: 2_300_000_000, downloadedBytes: 0, ready: false },
  },
  recommended,
  consent: "unasked",
  loadedProfile: null,
});

describe("TranscriptTab", () => {
  it("shows every word in order, grouped into paragraphs", async () => {
    ready([...SHORT.slice(0, 3), word("later", 200, 210)]);
    await using screen = await renderTab(wholeClip(300));
    await expect.element(screen.getByRole("option", { name: "hello" })).toBeVisible();
    const groups = screen.container.querySelectorAll('[role="group"]');
    expect([...groups].map((group) => group.textContent?.trim())).toEqual([
      "hello there silence",
      "later",
    ]);
  });

  it("seeks on click to the word's start frame", async () => {
    ready(SHORT);
    using listener = listenForSeeks();
    await using screen = await renderTab({ fps: FPS, segments: SILENCE_CUT });
    await screen.getByRole("option", { name: "there" }).click();
    expect(listener.seeks).toEqual([12]);
    // "general" starts the second kept range, at edit frame 22.
    await screen.getByRole("option", { name: "general" }).click();
    expect(listener.seeks).toEqual([12, 22]);
  });

  it("strikes removed words, seeks past them and never highlights them", async () => {
    ready(SHORT);
    using listener = listenForSeeks();
    await using screen = await renderTab({ fps: FPS, segments: SILENCE_CUT });
    const removed = screen.getByRole("option", { name: "silence (removed)" });
    await expect.element(removed).toBeVisible();
    expect(getComputedStyle(removed.element()).textDecorationLine).toBe("line-through");
    await removed.click();
    expect(listener.seeks).toEqual([22]);
    await expect
      .poll(() => screen.container.querySelector('[role="status"]')?.textContent)
      .toMatch(/“silence” was cut/u);

    const seen = new Set<string | null | undefined>();
    for (let frame = 0; frame < 44; frame += 1) {
      publishPlayerFrame(projectKey, frame);
      for (const text of currentWords()) seen.add(text);
    }
    expect([...seen].toSorted()).toEqual(["general", "hello", "kenobi", "there"]);
  });

  it("should handle no transcript: offers Transcribe, then transcribes with a ready model", async () => {
    state.transcript = { _tag: "ready", transcript: null };
    commands.status.mockResolvedValueOnce({
      _tag: "Success",
      value: modelsStatus(true, "default"),
    });
    commands.run.mockResolvedValueOnce({ _tag: "Success", value: {} });
    await using screen = await renderTab(null);
    await expect.element(screen.getByText("Not transcribed yet")).toBeVisible();
    await screen.getByRole("button", { name: "Transcribe" }).click();
    await vi.waitFor(() =>
      expect(commands.run).toHaveBeenCalledWith({
        environmentId,
        input: { projectId, media: "clip-0" },
      }),
    );
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("asks once for the speech model when it is missing, with sizes and the light pre-selected on 8 GB", async () => {
    state.transcript = { _tag: "ready", transcript: null };
    commands.run.mockClear();
    commands.status.mockResolvedValueOnce({ _tag: "Success", value: modelsStatus(false, "light") });
    commands.download.mockImplementationOnce(async () => ({
      _tag: "Success",
      value: { profile: "light", ready: true, sizeBytes: 2_300_000_000 },
    }));
    commands.run.mockResolvedValueOnce({ _tag: "Success", value: {} });
    await using screen = await renderTab(null);
    await screen.getByRole("button", { name: "Transcribe" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("Standard, 3.7 GB")).toBeVisible();
    await expect.element(page.getByText("Light, 2.3 GB")).toBeVisible();
    await expect.element(page.getByRole("radio", { name: /Light/u })).toBeChecked();
    expect(commands.run).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Download 2.3 GB" }).click();
    await vi.waitFor(() =>
      expect(commands.download).toHaveBeenCalledWith({
        environmentId,
        input: { model: "light", projectId },
      }),
    );
    await vi.waitFor(() =>
      expect(commands.run).toHaveBeenCalledWith({
        environmentId,
        input: { projectId, media: "clip-0", model: "light" },
      }),
    );
    await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
    expect(commands.status).toHaveBeenCalledOnce();
  });

  it("shows the download's progress and cancels it, even before its job is listed", async () => {
    state.transcript = { _tag: "ready", transcript: null };
    commands.run.mockClear();
    commands.cancel.mockClear();
    commands.status.mockResolvedValueOnce({
      _tag: "Success",
      value: modelsStatus(false, "default"),
    });
    let finishDownload: (result: unknown) => void = () => {};
    commands.download.mockImplementationOnce(
      () => new Promise((resolve) => (finishDownload = resolve)),
    );
    await using screen = await renderTab(null);
    await screen.getByRole("button", { name: "Transcribe" }).click();
    await page.getByRole("button", { name: "Download 3.7 GB" }).click();
    await expect
      .element(page.getByRole("progressbar", { name: "Speech model download" }))
      .toBeVisible();

    // Cancel before the job reaches the jobs stream: it waits for the job's id.
    await page.getByRole("button", { name: "Cancel download" }).click();
    expect(commands.cancel).not.toHaveBeenCalled();
    const job: EngineJob = {
      id: EngineJobId.make("download-1"),
      kind: "transcribe.models.download",
      progress: 0.3,
      stage: null,
      state: "running",
    };
    await act(() => jobsStore.set({ transcribe: null, download: job }));
    await expect
      .element(page.getByRole("progressbar", { name: "Speech model download" }))
      .toHaveAttribute("aria-valuenow", "30");
    expect(commands.cancel).toHaveBeenCalledWith({ environmentId, input: { jobId: "download-1" } });
    expect(commands.cancel).toHaveBeenCalledOnce();

    await act(() => {
      jobsStore.set({ transcribe: null, download: null });
      finishDownload({
        _tag: "Failure",
        cause: Cause.fail(
          new EngineError({ reason: "cancelled", method: "transcribe.models.download" }),
        ),
      });
    });
    await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
    expect(commands.run).not.toHaveBeenCalled();
  });

  it("cancels a listed download at once", async () => {
    state.transcript = { _tag: "ready", transcript: null };
    commands.cancel.mockClear();
    commands.status.mockResolvedValueOnce({
      _tag: "Success",
      value: modelsStatus(false, "default"),
    });
    commands.download.mockImplementationOnce(() => new Promise(() => {}));
    await using screen = await renderTab(null);
    await screen.getByRole("button", { name: "Transcribe" }).click();
    await page.getByRole("button", { name: "Download 3.7 GB" }).click();
    const job: EngineJob = {
      id: EngineJobId.make("download-2"),
      kind: "transcribe.models.download",
      progress: 0.5,
      stage: null,
      state: "running",
    };
    await act(() => jobsStore.set({ transcribe: null, download: job }));
    await page.getByRole("button", { name: "Cancel download" }).click();
    expect(commands.cancel).toHaveBeenCalledWith({ environmentId, input: { jobId: "download-2" } });
    await act(() => jobsStore.set({ transcribe: null, download: null }));
  });

  it("records 'Not now' and closes the question", async () => {
    state.transcript = { _tag: "ready", transcript: null };
    commands.status.mockResolvedValueOnce({
      _tag: "Success",
      value: modelsStatus(false, "default"),
    });
    await using screen = await renderTab(null);
    await screen.getByRole("button", { name: "Transcribe" }).click();
    await page.getByRole("button", { name: "Not now" }).click();
    expect(commands.dismiss).toHaveBeenCalledWith({ environmentId, input: {} });
    await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
  });

  it("shows progress during transcription", async () => {
    state.transcript = { _tag: "ready", transcript: null };
    const job: EngineJob = {
      id: EngineJobId.make("job-1"),
      kind: "transcribe",
      progress: 0.42,
      stage: null,
      state: "running",
      projectId,
    };
    await using screen = await renderTab(null);
    await act(() => jobsStore.set({ transcribe: job, download: null }));
    await expect
      .element(screen.getByRole("progressbar", { name: "Transcription" }))
      .toHaveAttribute("aria-valuenow", "42");
    await act(() => jobsStore.set({ transcribe: null, download: null }));
  });

  it("should handle an empty transcript", async () => {
    ready([]);
    await using screen = await renderTab(wholeClip(300));
    await expect.element(screen.getByText("No speech found")).toBeVisible();
  });

  it("should handle every word removed", async () => {
    ready(SHORT);
    await using screen = await renderTab({ fps: FPS, segments: [] });
    await expect.element(screen.getByText(/Every word was cut/u)).toBeVisible();
    expect(screen.container.querySelectorAll("[data-removed]")).toHaveLength(SHORT.length);
  });

  it("should handle 5,000 words: mounts only the visible rows", async () => {
    ready(synthetic(5_000));
    await using screen = await renderTab(wholeClip(100_000));
    await expect.element(screen.getByRole("option", { name: "word0", exact: true })).toBeVisible();
    // First-render time and long tasks are measured in the transcript-word-sync golden.
    expect(screen.container.querySelectorAll("[data-word]").length).toBeLessThan(500);
  });

  it("should not re-render per frame: the highlight moves by attribute", async () => {
    ready(synthetic(5_000));
    let renders = 0;
    await using screen = await renderTab(wholeClip(100_000), { onRender: () => (renders += 1) });
    await expect.element(screen.getByRole("option", { name: "word0", exact: true })).toBeVisible();
    const before = renders;
    // 600 frames, ending inside word 50.
    for (let frame = startOf(50) - 599; frame <= startOf(50); frame += 1) {
      publishPlayerFrame(projectKey, frame);
    }
    expect(renders).toBe(before);
    expect(document.querySelectorAll("[data-current]")).toHaveLength(1);
  });

  it("follows playback into rows not yet mounted, and holds after the user scrolls", async () => {
    ready(synthetic(5_000));
    await using screen = await renderTab(wholeClip(100_000));
    await expect.element(screen.getByRole("option", { name: "word0", exact: true })).toBeVisible();
    await act(() => publishPlayerFrame(projectKey, startOf(4_000) + 2));
    await expect
      .element(screen.getByRole("option", { name: "word4000", exact: true }))
      .toBeInViewport();
    expect(currentWords()).toEqual(["word4000"]);

    // Scrolling away holds the follow: the next word plays off screen.
    const list = scroller(screen);
    list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    const held = list.scrollTop;
    await act(() => publishPlayerFrame(projectKey, startOf(1)));
    expect(list.scrollTop).toBe(held);
  });

  it("seeks to the clicked word on the first click, even with the playing word off screen", async () => {
    ready(synthetic(5_000));
    using listener = listenForSeeks();
    await using screen = await renderTab(wholeClip(100_000));
    await expect.element(screen.getByRole("option", { name: "word0", exact: true })).toBeVisible();
    await act(() => publishPlayerFrame(projectKey, startOf(4_000) + 2));
    await expect
      .element(screen.getByRole("option", { name: "word4000", exact: true }))
      .toBeInViewport();
    // The user scrolls back to the top and clicks a word there: the list must not jump back.
    const list = scroller(screen);
    list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    await act(() => {
      list.scrollTop = 0;
    });
    const target = screen.getByRole("option", { name: "word3", exact: true });
    await expect.element(target).toBeInViewport();
    await userEvent.click(target);
    expect(listener.seeks).toEqual([startOf(3)]);
    expect(list.scrollTop).toBe(0);
    await expect
      .element(screen.getByRole("listbox", { name: "Transcript" }))
      .toHaveAttribute("aria-activedescendant", target.element().id);
  });

  it("keeps its model while the plan is rebuilt with the same frames", async () => {
    ready(SHORT);
    await using screen = await renderTab({ fps: FPS, segments: SILENCE_CUT });
    await expect.element(screen.getByRole("option", { name: "hello" })).toBeVisible();
    const before = builds.count;
    // A library update makes the panel rebuild its plan: new objects, the same frames.
    await screen.setPlayback({
      fps: { ...FPS },
      segments: SILENCE_CUT.map((entry) => ({ ...entry })),
    });
    expect(builds.count).toBe(before);
    await screen.setPlayback({ fps: FPS, segments: segmentsOf([[0, 62]]) });
    expect(builds.count).toBe(before + 1);
    await expect
      .element(screen.getByRole("option", { name: "silence", exact: true }))
      .toBeVisible();
  });

  it("should keep scroll on agent edit, updating struck words", async () => {
    ready(synthetic(5_000));
    await using screen = await renderTab(wholeClip(100_000));
    await expect.element(screen.getByRole("option", { name: "word0", exact: true })).toBeVisible();
    const list = scroller(screen);
    list.scrollTop = 2_000;
    await expect.poll(() => list.scrollTop).toBe(2_000);
    const firstOnScreen = () =>
      [...screen.container.querySelectorAll<HTMLElement>("[data-word]")].find(
        (element) => element.getBoundingClientRect().top > list.getBoundingClientRect().top,
      );
    await expect.poll(firstOnScreen).toBeTruthy();
    const visible = firstOnScreen()!;
    const index = Number(visible.dataset.word);
    // Cut the word on screen: its 8 frames go, the rest stays.
    const start = startOf(index);
    await screen.setPlayback({
      fps: FPS,
      segments: segmentsOf([
        [0, start],
        [start + 8, 100_000],
      ]),
    });
    await expect
      .poll(() => document.getElementById(visible.id)?.hasAttribute("data-removed"))
      .toBe(true);
    expect(list.scrollTop).toBe(2_000);
  });

  it("is reachable by keyboard inside virtualised rows: Tab, arrows, End, Enter", async () => {
    ready(synthetic(5_000));
    using listener = listenForSeeks();
    await using screen = await renderTab(wholeClip(100_000));
    await expect.element(screen.getByRole("option", { name: "word0", exact: true })).toBeVisible();
    await userEvent.tab();
    const listbox = screen.getByRole("listbox", { name: "Transcript" });
    await expect.element(listbox).toHaveFocus();
    const active = () => {
      const id = listbox.element().getAttribute("aria-activedescendant");
      return id === null ? null : document.getElementById(id)?.firstChild?.textContent;
    };
    expect(active()).toBe("word0");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(active()).toBe("word2");
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toBe("word40");
    await userEvent.keyboard("{End}");
    // The last row was not mounted until the list scrolled to it.
    await expect.poll(active).toBe("word4999");
    await userEvent.keyboard("{Enter}");
    expect(listener.seeks).toEqual([startOf(4_999)]);
    await userEvent.keyboard("{Home}");
    await expect.poll(active).toBe("word0");
  });

  it("meets WCAG AA contrast for the current and removed words in both themes", async () => {
    ready(SHORT);
    await using screen = await renderTab({ fps: FPS, segments: SILENCE_CUT });
    await expect.element(screen.getByRole("option", { name: "hello" })).toBeVisible();
    publishPlayerFrame(projectKey, 0);
    const background = () => getComputedStyle(document.body).backgroundColor;
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    /** The colour as painted over the page background, so translucent tints count. */
    const rgb = (color: string) => {
      canvas.fillStyle = background();
      canvas.fillRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const luminance = (color: string) => {
      const [r, g, b] = rgb(color).map((value) => {
        const channel = value / 255;
        return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (first: string, second: string) => {
      const [light, dark] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
      return (light! + 0.05) / (dark! + 0.05);
    };
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const current = getComputedStyle(wordElement("hello")!);
      const removed = getComputedStyle(wordElement("silence")!);
      expect(contrast(current.color, current.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(removed.color, background())).toBeGreaterThanOrEqual(4.5);
    }
    document.documentElement.classList.remove("dark");
  });

  describe("text editing (S7V-038)", () => {
    it("cuts dragged words with Delete through one apply on the rendered revision", async () => {
      ready(SHORT);
      const { editing, apply } = editingOf([[0, 62]], 62);
      await using screen = await renderTab(wholeClip(62), { editing });
      await expect.element(screen.getByRole("option", { name: "there" })).toBeVisible();
      await act(() => dragAcross("there", "silence"));
      expect(selectedWords()).toEqual(["there", "silence"]);
      await expect
        .element(screen.getByRole("option", { name: "silence" }))
        .toHaveAttribute("aria-selected", "true");
      await expect.element(screen.getByText("2 words selected")).toBeVisible();
      await userEvent.keyboard("{Delete}");
      expect(apply).toHaveBeenCalledOnce();
      const [ops, baseRevision] = apply.mock.calls[0]!;
      expect(baseRevision).toBe(7);
      // From there's start (the 2-frame gap after hello has no room for air) to general's start - 3.
      expect(ops).toEqual([
        { _tag: "splitItem", itemId: "v1", atFrame: 37, newItemId: "vt1" },
        { _tag: "splitItem", itemId: "v1", atFrame: 12, newItemId: "vt2" },
        { _tag: "deleteItem", itemIds: ["vt2"], ripple: true },
      ]);
      // Struck at once, before the new edit arrives; then the edit keeps them struck.
      await expect.poll(() => wordElement("there")?.hasAttribute("data-removed")).toBe(true);
      await screen.setPlayback({
        fps: FPS,
        segments: segmentsOf([
          [0, 12],
          [37, 62],
        ]),
      });
      expect(wordElement("silence")?.hasAttribute("data-removed")).toBe(true);
      expect(wordElement("general")?.hasAttribute("data-removed")).toBe(false);
      expect(selectedWords()).toEqual([]);
    });

    it("keeps a single click a seek, and selects by shift-click", async () => {
      ready(SHORT);
      using listener = listenForSeeks();
      const { editing, apply } = editingOf([[0, 62]], 62);
      await using screen = await renderTab(wholeClip(62), { editing });
      await screen.getByRole("option", { name: "there" }).click();
      expect(listener.seeks).toEqual([12]);
      expect(selectedWords()).toEqual([]);
      await userEvent.keyboard("{Shift>}");
      await screen.getByRole("option", { name: "general" }).click();
      await userEvent.keyboard("{/Shift}");
      expect(listener.seeks).toEqual([12]);
      expect(selectedWords()).toEqual(["there", "silence", "general"]);
      await screen.getByRole("button", { name: /Cut/u }).click();
      expect(apply).toHaveBeenCalledOnce();
    });

    it("restores struck words with the Restore button", async () => {
      ready(SHORT);
      // silence [24,36) is cut: the edit plays [0,22) and [40,62).
      const { editing, apply } = editingOf(
        [
          [0, 22],
          [40, 62],
        ],
        62,
      );
      await using screen = await renderTab({ fps: FPS, segments: SILENCE_CUT }, { editing });
      await act(() => dragAcross("silence", "silence"));
      // A press and release on one word is a click, which seeks and selects nothing.
      expect(selectedWords()).toEqual([]);
      await userEvent.keyboard("{Shift>}");
      await screen.getByRole("option", { name: "silence (removed)" }).click();
      await userEvent.keyboard("{/Shift}");
      expect(screen.getByRole("button", { name: /Cut/u }).query()).toBeNull();
      await screen.getByRole("button", { name: /Restore/u }).click();
      expect(apply.mock.calls[0]![0]).toEqual([
        { _tag: "restoreRange", trackId: "V1", mediaId: "clip-0", range: { in: 22, duration: 18 } },
      ]);
    });

    it("should handle a stale revision: keeps the selection, rolls back and says so", async () => {
      ready(SHORT);
      const { editing } = editingOf([[0, 62]], 62, { _tag: "conflict" });
      await using screen = await renderTab(wholeClip(62), { editing });
      await act(() => dragAcross("there", "there"));
      await userEvent.keyboard("{Shift>}");
      await screen.getByRole("option", { name: "silence" }).click();
      await userEvent.keyboard("{/Shift}");
      await screen.getByRole("button", { name: /Cut/u }).click();
      await expect.element(screen.getByText(TRANSCRIPT_CONFLICT_NOTICE)).toBeVisible();
      expect(wordElement("silence")?.hasAttribute("data-removed")).toBe(false);
      expect(selectedWords()).toEqual(["there", "silence"]);
    });

    it("says when a cut also takes a short leftover", async () => {
      // An earlier cut ends at 11: cutting from two's air (13) would leave [11,13) alone.
      ready([word("one", 0, 10), word("two", 20, 30), word("three", 40, 50)]);
      const kept = [
        [0, 10],
        [11, 62],
      ] as const;
      const { editing, apply } = editingOf(kept, 62);
      await using screen = await renderTab({ fps: FPS, segments: segmentsOf(kept) }, { editing });
      await act(() => dragAcross("two", "three"));
      await userEvent.keyboard("{Backspace}");
      expect(apply.mock.calls[0]![0].at(-1)).toEqual({
        _tag: "deleteItem",
        itemIds: ["v2"],
        ripple: true,
      });
      await expect
        .element(screen.getByText(/Also cut 0\.1 s between these words/u).first())
        .toBeVisible();
    });

    it("is keyboard only: shift+arrows select, Delete cuts, Backspace restores", async () => {
      ready(SHORT);
      const { editing, apply } = editingOf([[0, 62]], 62);
      await using screen = await renderTab(wholeClip(62), { editing });
      await expect.element(screen.getByRole("option", { name: "hello" })).toBeVisible();
      await userEvent.tab();
      await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
      expect(selectedWords()).toEqual(["there", "silence"]);
      await userEvent.keyboard("{Delete}");
      expect(apply.mock.calls[0]![0].at(-1)).toMatchObject({ _tag: "deleteItem" });
      const cut = editingOf(
        [
          [0, 12],
          [37, 62],
        ],
        62,
      );
      await screen.setPlayback(
        {
          fps: FPS,
          segments: segmentsOf([
            [0, 12],
            [37, 62],
          ]),
        },
        cut.editing,
      );
      // VoiceOver reads the struck words as removed.
      await expect.element(screen.getByRole("option", { name: "there (removed)" })).toBeVisible();
      await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}{Backspace}");
      expect(cut.apply.mock.calls[0]![0]).toEqual([
        { _tag: "restoreRange", trackId: "V1", mediaId: "clip-0", range: { in: 12, duration: 25 } },
      ]);
    });

    it("selects nothing and offers no actions while the edit cannot be changed", async () => {
      ready(SHORT);
      await using screen = await renderTab(wholeClip(62));
      await act(() => dragAcross("there", "silence"));
      expect(selectedWords()).toEqual([]);
      await userEvent.tab();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}{Delete}");
      expect(selectedWords()).toEqual([]);
      expect(screen.getByRole("toolbar").query()).toBeNull();
    });

    it("should handle a 30-minute transcript: 50 words in one apply, no long task", async () => {
      // 30 minutes at 30 fps: 54,000 frames, 4,500 words.
      ready(synthetic(4_500));
      const frames = startOf(4_499) + 8;
      const { editing, apply } = editingOf([[0, frames]], frames);
      await using screen = await renderTab(wholeClip(frames), { editing });
      await expect
        .element(screen.getByRole("option", { name: "word0", exact: true }))
        .toBeVisible();
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      await act(() => dragAcross("word2", "word51"));
      expect(selectedWords()).toHaveLength(50);
      await userEvent.keyboard("{Delete}");
      await expect.poll(() => wordElement("word30")?.hasAttribute("data-removed")).toBe(true);
      observer.disconnect();
      expect(apply).toHaveBeenCalledOnce();
      expect(longTasks.filter((duration) => duration > 50)).toEqual([]);
    });

    it("meets WCAG AA contrast for selected words in both themes", async () => {
      ready(SHORT);
      const { editing } = editingOf(
        [
          [0, 22],
          [40, 62],
        ],
        62,
      );
      await using screen = await renderTab({ fps: FPS, segments: SILENCE_CUT }, { editing });
      await expect.element(screen.getByRole("option", { name: "there" })).toBeVisible();
      await act(() => dragAcross("there", "general"));
      const canvas = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true })!;
      const rgb = (color: string) => {
        canvas.fillStyle = getComputedStyle(document.body).backgroundColor;
        canvas.fillRect(0, 0, 1, 1);
        canvas.fillStyle = color;
        canvas.fillRect(0, 0, 1, 1);
        return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const luminance = (color: string) => {
        const [r, g, b] = rgb(color).map((value) => {
          const channel = value / 255;
          return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const contrast = (first: string, second: string) => {
        const [light, dark] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
        return (light! + 0.05) / (dark! + 0.05);
      };
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle("dark", dark);
        for (const text of ["there", "silence"]) {
          const style = getComputedStyle(wordElement(text)!);
          expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
        }
      }
      document.documentElement.classList.remove("dark");
    });
  });
});
