// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Golden `multi-clip-gapless`, playback half (S7V-039): the real `MultiClipPlayer` on 3 synthetic
 * H.264 sources, 12 segments with a gap. Every join is read from rVFC. Playwright's Chromium has no
 * HEVC decoder; the spike measured HEVC in Electron. Export half: multi_clip_gapless_golden.py.
 */
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import "../../index.css";

import { render } from "../../../test/render";
import { frameAtTime, type TimelinePlan, type TimelineSegment } from "../../editor/editPlayback";
import { requestPlayerSeek, subscribePlayerFrame } from "../../editor/editStore";
import type { JoinSample } from "../../editor/playerClock";
import { MultiClipPlayer, type MultiClipSource } from "./MultiClipPlayer";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    synthMediaPath: (spec: string) => Promise<string>;
  }
}

const FPS = { num: 30, den: 1 };
const FRAME_MS = 1000 / 30;
const projectKey = "env-golden:project-multi-clip";

/** Three sources unlike each other in size and keyframe spacing (the 2 s GOP is the hard one). */
const SOURCES = {
  a: { name: "multi-clip-a", width: 1280, height: 720, gop: 30, toneHz: 440 },
  b: { name: "multi-clip-b", width: 1920, height: 1080, gop: 60, toneHz: 660 },
  c: { name: "multi-clip-c", width: 640, height: 360, gop: 15, toneHz: 880 },
} as const;

/** The same layout the spike measured: alternating sources, odd ins, a gap before item 8. */
const MULTI_CLIP_LAYOUT: ReadonlyArray<readonly [keyof typeof SOURCES, number, number]> = [
  ["a", 10, 30],
  ["b", 47, 25],
  ["c", 73, 40],
  ["a", 120, 20],
  ["b", 5, 33],
  ["c", 200, 28],
  ["a", 260, 31],
  ["b", 150, 22],
  ["c", 17, 35],
  ["a", 40, 26],
  ["b", 300, 30],
  ["c", 290, 24],
];
const GAP_BEFORE = 7;
const GAP_FRAMES = 15;

const planOf = (): TimelinePlan => {
  let at = 0;
  const segments: TimelineSegment[] = MULTI_CLIP_LAYOUT.map(([mediaId, inFrame, duration], k) => {
    if (k === GAP_BEFORE) at += GAP_FRAMES;
    const segment = { mediaId, start: at, end: at + duration, in: inFrame, muted: false };
    at += duration;
    return segment;
  });
  return { fps: FPS, segments, durationFrames: at, mediaIds: ["a", "b", "c"] };
};

interface Presented {
  readonly at: number;
  readonly edit: number;
  /** The frame the clock published for this presentation (what the timeline playhead shows). */
  readonly published: number;
  /** Audio clock minus picture at display time, ms: positive means audio leads (proxy). */
  readonly avMs: number;
}

/** Runs `callback` in a task after the current rendering step (rVFC, then rAF) has finished. */
const afterRenderingStep = (callback: () => void) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    callback();
  };
  channel.port2.postMessage(null);
};

describe("multi-clip-gapless", () => {
  it("plays 12 segments from 3 sources with no black or frozen frame over one at any join", async () => {
    const paths = Object.fromEntries(
      await Promise.all(
        Object.entries(SOURCES).map(async ([id, source]) => [
          id,
          await commands.synthMediaPath(
            JSON.stringify({
              name: source.name,
              width: source.width,
              height: source.height,
              gop: source.gop,
              audio: [{ seconds: 12, toneHz: source.toneHz }],
            }),
          ),
        ]),
      ),
    ) as Record<keyof typeof SOURCES, string>;
    const plan = planOf();
    const sources = new Map<string, MultiClipSource>(
      Object.entries(paths).map(([id, path]) => [
        id,
        { label: `${id}.mp4`, url: `/@fs${path}`, status: "ready" },
      ]),
    );
    const joins: JoinSample[] = [];
    let ended: () => void = () => {};
    const finished = new Promise<void>((resolve) => (ended = resolve));
    const container = document.createElement("div");
    container.style.cssText = "width:640px;height:480px";
    await using screen = await render(
      createElement(MultiClipPlayer, {
        projectKey,
        plan,
        sources,
        label: "multi-clip",
        startFrame: 0,
        onPositionChange: () => {},
        onSourceError: (mediaId) => {
          throw new Error(`source ${mediaId} failed to load`);
        },
        onPlayingChange: (playing) => {
          if (!playing) ended();
        },
        onJoin: (sample) => joins.push(sample),
      }),
      { container, router: false },
    );
    const videos = [...screen.container.querySelectorAll("video")];

    // Every element's presented frames. rVFC callbacks run before the rendering step's rAF
    // callbacks, where the clock swaps elements at a join, so what is on screen (the visible
    // element, its segment, the published frame) is read after the whole step has run.
    let published = 0;
    const stopFrames = subscribePlayerFrame(projectKey, (frame) => {
      published = frame;
    });
    const presented: Presented[] = [];
    let recording = true;
    for (const video of videos) {
      const watch = () =>
        video.requestVideoFrameCallback((now, metadata) => {
          if (!recording) return;
          const mediaFrame = frameAtTime(metadata.mediaTime, FPS);
          const avMs =
            (video.currentTime - metadata.mediaTime) * 1000 + (metadata.expectedDisplayTime - now);
          afterRenderingStep(() => {
            if (video.style.opacity !== "1") return;
            const join = joins.at(-1);
            const segment = join === undefined ? undefined : plan.segments[join.segment];
            if (segment === undefined) return;
            presented.push({
              at: metadata.expectedDisplayTime,
              edit: segment.start + mediaFrame - segment.in,
              published,
              avMs,
            });
          });
          watch();
        });
      watch();
    }
    // Wait until the first element is parked and shown.
    await expect.element(screen.getByRole("button", { name: "Play" })).toBeVisible();
    await new Promise<void>((resolve) => {
      const check = () =>
        videos.some((video) => video.style.opacity === "1")
          ? resolve()
          : requestAnimationFrame(check);
      check();
    });
    // A real click: unmuted playback needs a user gesture.
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    await finished;
    recording = false;
    await new Promise<void>((resolve) => afterRenderingStep(resolve));
    stopFrames();

    // Across each join, consecutive presented frames e1 -> e2 at t1 -> t2: the parked first frame
    // shows between them without a callback, so any time beyond (e2 - e1) frames is black or
    // frozen. Skipped frames show as e2 - e1 above what the time allows.
    const perJoin = joins.slice(1).map((join) => {
      const segment = plan.segments[join.segment]!;
      const last = presented.findLast((entry) => entry.edit < segment.start)!;
      const first = presented.find((entry) => entry.at > last.at && entry.edit >= segment.start)!;
      const blackFrames = join.segment === GAP_BEFORE ? GAP_FRAMES : 0;
      const spanFrames = (first.at - last.at) / FRAME_MS;
      const steps = first.edit - last.edit;
      return {
        segment: join.segment,
        spanFrames: Math.round(spanFrames * 10) / 10,
        steps,
        frozen: Math.max(0, Math.round(spanFrames) - steps),
        skipped: Math.max(
          0,
          steps - blackFrames - Math.max(1, Math.round(spanFrames) - blackFrames) - 1,
        ),
        lateMs: Math.round(join.displayAt - join.dueAt),
        readyLeadMs: Math.round(join.readyLeadMs),
      };
    });
    const av = presented.map((entry) => entry.avMs).toSorted((left, right) => left - right);
    const playheadDrift = Math.max(
      ...presented.map((entry) => Math.abs(entry.edit - entry.published)),
    );
    console.info(
      `multi-clip-gapless: ${presented.length} frames, joins ${JSON.stringify(perJoin)}, A/V proxy median ${av[av.length >> 1]?.toFixed(1)} ms, p95 ${av[Math.floor(av.length * 0.95)]?.toFixed(1)} ms, playhead drift ${playheadDrift} frames`,
    );

    expect(joins.map((join) => join.segment)).toEqual(plan.segments.map((_, index) => index));
    for (const join of perJoin) {
      // Every element was parked before its join, so no "Preparing next clip…" hold.
      expect(join.readyLeadMs, `join ${join.segment}`).toBeGreaterThan(0);
      expect(join.frozen, `join ${join.segment} black or frozen frames`).toBeLessThanOrEqual(1);
      expect(join.skipped, `join ${join.segment} skipped frames`).toBe(0);
    }
    // The timeline playhead hears the frame on screen (AC-8).
    expect(playheadDrift).toBe(0);
    // Nothing past the edit's end is shown: export stops there too.
    expect(Math.max(...presented.map((entry) => entry.edit))).toBe(plan.durationFrames - 1);
    // Audio follows its own element: within one frame of the picture.
    expect(av[Math.floor(av.length * 0.95)]!).toBeLessThanOrEqual(FRAME_MS);
    expect(av[Math.floor(av.length * 0.05)]!).toBeGreaterThanOrEqual(-FRAME_MS);

    // A seek into another source shows its exact frame within 0.5 s (AC-5).
    const target = plan.segments[4]!.start + 10;
    const expectedSource = plan.segments[4]!.in + 10;
    // Rendering steps (rAF timestamps) from the seek until the element on screen settles there.
    const landed = new Promise<number>((resolve) => {
      let startedAt: number | null = null;
      const check = (time: number) => {
        startedAt ??= time;
        const shownVideo = videos.find((video) => video.style.opacity === "1");
        if (
          shownVideo !== undefined &&
          !shownVideo.seeking &&
          shownVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          frameAtTime(shownVideo.currentTime, FPS) === expectedSource
        ) {
          resolve(time - startedAt);
        } else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    requestPlayerSeek(projectKey, target);
    const seekMs = await landed;
    const visible = videos.find((video) => video.style.opacity === "1")!;
    expect(frameAtTime(visible.currentTime, FPS)).toBe(plan.segments[4]!.in + 10);
    console.info(`multi-clip-gapless: seek into another source shown in ${seekMs.toFixed(0)} ms`);
    expect(seekMs).toBeLessThan(500);
  });
});
