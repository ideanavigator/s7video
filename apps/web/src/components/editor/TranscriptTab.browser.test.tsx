// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EngineJobId,
  type EngineJob,
  EnvironmentId,
  ProjectId,
  type Transcript,
  type TranscribeModelsStatus,
  type TranscriptWord,
} from "@t3tools/contracts";
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

import { TranscriptTab } from "./TranscriptTab";

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
  options: { readonly onRender?: () => void } = {},
) => {
  const ui = (next: TranscriptPlayback | null) => (
    <Profiler id="transcript" onRender={() => options.onRender?.()}>
      <TranscriptTab projectRef={projectRef} mediaId="clip-0" playback={next} />
    </Profiler>
  );
  return render(ui(playback), { container: sized(), router: false }).then((screen) =>
    Object.assign(screen, {
      setPlayback: (next: TranscriptPlayback | null) => screen.rerender(ui(next)),
    }),
  );
};

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
});
