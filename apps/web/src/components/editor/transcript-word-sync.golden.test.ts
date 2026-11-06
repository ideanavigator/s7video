// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Golden `transcript-word-sync` (S7V-030): the real player on `talking-head-01` and its reference
 * words. The highlight changes within one frame of each word start, skips cut words, and a click
 * seeks to the exact presented frame. 60 s with 5,000 words: first render and long tasks.
 */
import { EnvironmentId, ProjectId, type Transcript, type TranscriptWord } from "@t3tools/contracts";
import { createElement, Profiler, type ProfilerOnRenderCallback } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import type { MediaTranscriptState } from "../../editor/editStore";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts: the cached clip's path, or null before `pnpm media:fetch`. */
    testMediaPath: (file: string) => Promise<string | null>;
  }
}

const state = vi.hoisted(() => ({
  transcript: { _tag: "loading" } as MediaTranscriptState,
}));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useMediaTranscript: () => state.transcript,
  useTranscriptionJobs: () => ({ transcribe: null, download: null }),
}));

import "../../index.css";

import reference from "../../../../../fixtures/media/talking-head-01.words.json";
import { render } from "../../../test/render";
import {
  frameAtTime,
  type PlaybackPlan,
  type PlaybackSegment,
  sourceFrameOf,
} from "../../editor/editPlayback";
import { subscribePlayerFrame } from "../../editor/editStore";
import { EditPlayer } from "./EditPlayer";
import { TranscriptTab } from "./TranscriptTab";

const FPS = { num: 24_000, den: 1_001 };
const environmentId = EnvironmentId.make("env-golden");
const projectId = ProjectId.make("project-golden");
const projectKey = `${environmentId}:${projectId}`;
const mediaPath = await commands.testMediaPath(reference.clip + ".webm");

const transcriptOf = (words: ReadonlyArray<TranscriptWord>): Transcript => ({
  transcriptVersion: 1,
  mediaFingerprint: { sha256: reference.sha256, size: 12_247_260 },
  model: "reference",
  revision: "talking-head-01.words.json",
  fps: FPS,
  durationFrames: 3_340,
  words,
  createdAt: "2026-11-06T00:00:00Z",
});

const referenceWords: TranscriptWord[] = reference.words.map((word) => ({
  text: word.text,
  startFrame: word.start,
  endFrame: word.end,
  confidence: null,
  speaker: "S1",
}));

const planOf = (ranges: ReadonlyArray<readonly [number, number]>): PlaybackPlan => {
  const segments: PlaybackSegment[] = [];
  let timeline = 0;
  for (const [start, end] of ranges) {
    segments.push({ sourceStart: start, sourceEnd: end, timelineStart: timeline });
    timeline += end - start;
  }
  return {
    mediaId: reference.clip,
    fps: FPS,
    segments,
    durationFrames: timeline,
    otherClipItems: 0,
  };
};

const mount = async (plan: PlaybackPlan, onRender: ProfilerOnRenderCallback = () => {}) => {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:480px;height:760px";
  const screen = await render(
    createElement(
      "div",
      { className: "flex h-full flex-col" },
      createElement(EditPlayer, {
        projectKey,
        src: `/@fs${mediaPath}`,
        label: reference.clip,
        plan,
        startFrame: 0,
        onPositionChange: () => {},
        onError: () => {},
      }),
      createElement(
        "div",
        { className: "flex min-h-0 flex-1 flex-col" },
        createElement(
          Profiler,
          { id: "transcript", onRender },
          createElement(TranscriptTab, {
            projectRef: { environmentId, projectId },
            mediaId: reference.clip,
            playback: { fps: FPS, segments: plan.segments },
          }),
        ),
      ),
    ),
    { container, router: false },
  );
  const video = screen.container.querySelector("video")!;
  video.muted = true;
  if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    await new Promise((resolve) => video.addEventListener("canplay", resolve, { once: true }));
  }
  return { screen, video };
};

const currentWord = () => document.querySelector("[data-current]")?.firstChild?.textContent ?? null;

/** The next frame the paused video presents (after a seek), as a source frame. */
const nextPresentedFrame = (video: HTMLVideoElement) =>
  new Promise<number>((resolve) =>
    video.requestVideoFrameCallback((_now, metadata) =>
      resolve(frameAtTime(metadata.mediaTime, FPS)),
    ),
  );

const ended = (video: HTMLVideoElement) =>
  new Promise((resolve) => video.addEventListener("pause", resolve, { once: true }));

const NO_CLIP =
  "talking-head-01 is not in the test-media cache: run `pnpm media:fetch` (pnpm test:golden does it first)";

describe("transcript-word-sync", () => {
  it("highlights each word within one frame of its start, skips cut words, and seeks exactly", async ({
    skip,
  }) => {
    skip(mediaPath === null, NO_CLIP);
    state.transcript = { _tag: "ready", transcript: transcriptOf(referenceWords) };
    // Keeps "And", "do", "that" and "user"; the silence cut removes "It" (481-486).
    const plan = planOf([
      [400, 470],
      [640, 700],
    ]);
    const mounted = await mount(plan);
    await using screen = mounted.screen;
    const { video } = mounted;
    await expect.element(screen.getByRole("option", { name: "It (removed)" })).toBeVisible();

    // Runs after the tab's listener in the same frame callback, so it reads what that frame shows.
    const samples: Array<{ readonly frame: number; readonly word: string | null }> = [];
    const stop = subscribePlayerFrame(projectKey, (timelineFrame) => {
      samples.push({ frame: sourceFrameOf(plan.segments, timelineFrame), word: currentWord() });
    });
    const finished = ended(video);
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    await finished;
    stop();

    const expected = (frame: number) =>
      referenceWords.find(
        (word) => frame >= word.startFrame && frame < word.endFrame && word.text !== "It",
      )?.text ?? null;
    const mismatches = samples.filter((sample) => sample.word !== expected(sample.frame));
    const lags = ["And", "do", "that", "user"].map((text) => {
      const word = referenceWords.find((entry) => entry.text === text && entry.startFrame >= 400)!;
      const first = samples.find((sample) => sample.word === text);
      return { text, lagFrames: first === undefined ? null : first.frame - word.startFrame };
    });
    console.info(
      `transcript-word-sync: ${samples.length} frames sampled, ${mismatches.length} mismatches, lags ${JSON.stringify(lags)}`,
    );
    expect(samples.length).toBeGreaterThan(100);
    expect(samples.some((sample) => sample.word === "It")).toBe(false);
    for (const { lagFrames } of lags) {
      expect(lagFrames).not.toBeNull();
      expect(lagFrames!).toBeLessThanOrEqual(1);
    }
    expect(mismatches).toEqual([]);

    const seekTo = async (name: string) => {
      const presented = nextPresentedFrame(video);
      await userEvent.click(screen.getByRole("option", { name }));
      return presented;
    };
    expect(await seekTo("user")).toBe(665);
    expect(await seekTo("And")).toBe(419);
    // A cut word seeks to the next kept frame.
    expect(await seekTo("It (removed)")).toBe(640);
  });

  it("plays 60 s with a 5,000-word transcript and renders the transcript in under 100 ms, with no main-thread task over 50 ms", async ({
    skip,
  }) => {
    skip(mediaPath === null, NO_CLIP);
    const words = Array.from({ length: 5_000 }, (_, index): TranscriptWord => {
      const start = Math.floor((index * 3_300) / 5_000);
      return {
        text: `w${index}`,
        startFrame: start,
        endFrame: start + 1,
        confidence: null,
        speaker: "S1",
      };
    });
    state.transcript = { _tag: "ready", transcript: transcriptOf(words) };
    let renderMs = 0;
    const mounted = await mount(planOf([[0, 3_300]]), (_id, _phase, actualDuration) => {
      renderMs += actualDuration;
    });
    await using screen = mounted.screen;
    const { video } = mounted;
    await expect.element(screen.getByRole("option", { name: "w0", exact: true })).toBeVisible();
    // Every React commit of the tab up to the first words on screen.
    const firstRenderMs = renderMs;
    expect(PerformanceObserver.supportedEntryTypes).toContain("longtask");
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask" });
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    await new Promise<void>((resolve) => {
      const onTime = () => {
        if (video.currentTime < 60) return;
        video.removeEventListener("timeupdate", onTime);
        resolve();
      };
      video.addEventListener("timeupdate", onTime);
    });
    video.pause();
    observer.disconnect();
    const quality = video.getVideoPlaybackQuality();
    console.info(
      `transcript 5,000 words: first render ${firstRenderMs.toFixed(1)} ms; 60 s playback: long tasks ${JSON.stringify(longTasks.map(Math.round))}, frames ${quality.totalVideoFrames}, dropped ${quality.droppedVideoFrames}`,
    );
    expect(firstRenderMs).toBeLessThan(100);
    expect(longTasks).toEqual([]);
  });
});
