// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Golden `timeline-perf-1000` (S7V-033): the real player on a synthetic `testsrc2` clip beside the
 * generated 1,000-clip timeline. The playhead follows every presented frame within one frame.
 * Positions: the `talking-head-01` silence-cut edit reads back from the timeline to the frame.
 */
import type { EditDocument } from "@t3tools/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

import "../../../index.css";

import keep from "../../../../../../fixtures/media/talking-head-01.keep.json";
import { makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import { sampleFor, trackPresentedFrame } from "../../../../test/framePacing";
import { render } from "../../../../test/render";
import { editPlaybackPlan } from "../../../editor/editPlayback";
import { requestPlayerSeek, subscribePlayerFrame } from "../../../editor/editStore";
import { EditPlayer } from "../EditPlayer";
import { Timeline } from "./Timeline";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts: the cached clip's path, or null before `pnpm media:fetch`. */
    testMediaPath: (file: string) => Promise<string | null>;
    /** Defined in vite.config.ts: a synthetic clip from fixtures/media/synth.ts. */
    synthMediaPath: (spec: string) => Promise<string>;
  }
}

const PROJECT_KEY = "env-golden:project-timeline";

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

describe("timeline-perf-1000", () => {
  it("keeps the playhead within a frame of the presented frame while playing", async () => {
    const source = await commands.synthMediaPath(
      JSON.stringify({
        name: "timeline-testsrc2-180s",
        fps: "30/1",
        width: 640,
        height: 360,
        audio: [{ seconds: 180, toneHz: 440 }],
      }),
    );
    // The perf edit lays its video items end to end from frame 0 over the same 3 minutes, so the
    // player plays the clip straight through and its frames are the timeline's.
    const document = makePerfEdit(1_000);
    const plan = editPlaybackPlan(document)!;
    const container = window.document.createElement("div");
    container.style.cssText = "display:flex;flex-direction:column;width:1112px;height:760px";
    await using screen = await render(
      createElement(
        "div",
        { className: "flex h-full flex-col" },
        createElement(EditPlayer, {
          projectKey: PROJECT_KEY,
          src: `/@fs${source}`,
          label: "testsrc2",
          plan,
          startFrame: 0,
          onPositionChange: () => {},
          onError: () => {},
        }),
        createElement(
          "div",
          { style: { height: 240 } },
          createElement(Timeline, {
            projectKey: PROJECT_KEY,
            document,
            playheadVisible: true,
            initialFrame: 0,
            onSeek: (frame: number) => requestPlayerSeek(PROJECT_KEY, frame),
          }),
        ),
      ),
      { container, router: false },
    );
    const video = screen.container.querySelector("video")!;
    video.muted = true;
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      await new Promise((resolve) => video.addEventListener("canplay", resolve, { once: true }));
    }
    const playhead = screen.container.querySelector<HTMLElement>(
      "[data-testid=timeline-playhead]",
    )!;
    requestPlayerSeek(PROJECT_KEY, 900);
    await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));

    let published = 0;
    const stop = subscribePlayerFrame(PROJECT_KEY, () => {
      published += 1;
    });
    // Against the presented frame (the AC), and against `currentTime` (spike B1's measure).
    const drift: number[] = [];
    const clockDrift: number[] = [];
    const presented = trackPresentedFrame(video, 30);
    const playing = new Promise((resolve) =>
      video.addEventListener("playing", resolve, { once: true }),
    );
    await screen.getByRole("button", { name: "Play" }).click();
    await playing;
    published = 0;
    await sampleFor(10_000, 7, () => {
      const frame = presented.frame();
      if (video.paused || frame === null) return;
      const shown = Number(playhead.dataset.frame);
      drift.push(Math.abs(frame - shown));
      clockDrift.push(Math.abs(video.currentTime * 30 - shown));
    });
    video.pause();
    presented.stop();
    stop();

    const report = {
      publishedFrames: published,
      samples: drift.length,
      driftP50: percentile(drift, 0.5),
      driftP95: percentile(drift, 0.95),
      driftMax: Math.max(...drift),
      currentTimeDriftP95: percentile(clockDrift, 0.95),
      currentTimeDriftMax: Math.max(...clockDrift),
    };
    console.info(`S7V-033 timeline-perf-1000 playhead: ${JSON.stringify(report)}`);
    // About 300 presented frames in 10 s at 30 fps, each published once.
    expect(published).toBeGreaterThanOrEqual(285);
    expect(published).toBeLessThanOrEqual(305);
    expect(report.driftP95).toBeLessThan(1);
    expect(report.driftMax).toBeLessThan(1);
    // Against the video's own clock as well, which the presented frame lags by up to one frame.
    expect(report.currentTimeDriftMax).toBeLessThan(1);
  });

  it("reads the talking-head-01 silence cut back from the timeline to the frame", async () => {
    let start = 0;
    const items = keep.keep.map(([from, to], index) => {
      const item = { id: `cut-${index}`, media: "th01", start, duration: to! - from!, in: from! };
      start += to! - from!;
      return item;
    });
    const document: EditDocument = {
      version: 1,
      fps: { num: 24_000, den: 1_001 },
      canvas: { width: 1920, height: 1080 },
      media: [
        {
          id: "th01",
          kind: "video",
          path: "assets/talking-head-01.webm",
          fingerprint: { sha256: keep.sha256, size: 12_247_260 },
          probe: { durationFrames: 3_340, hasVideo: true, hasAudio: true },
        },
      ],
      tracks: [{ kind: "video", id: "V1", items }],
      markers: [],
      metadata: {},
    };
    const container = window.document.createElement("div");
    container.style.cssText = "width:1112px;height:240px";
    await using screen = await render(
      createElement(Timeline, {
        projectKey: PROJECT_KEY,
        document,
        playheadVisible: true,
        initialFrame: 0,
        onSeek: () => {},
      }),
      { container, router: false },
    );
    const scroller = screen.container.querySelector<HTMLElement>(
      "[data-testid=timeline-scroller]",
    )!;
    const ppf = Number(scroller.dataset.pxPerFrame);
    for (const item of items) {
      const block = screen.container.querySelector<HTMLElement>(
        `[data-timeline-item="${item.id}"]`,
      );
      if (block === null) {
        // Under 4 px at this zoom: drawn into the canvas strip, which the unit tests cover.
        expect(item.duration * ppf).toBeLessThan(4);
        continue;
      }
      expect([Number(block.dataset.start), Number(block.dataset.duration)]).toEqual([
        item.start,
        item.duration,
      ]);
      const lane = block.parentElement!.getBoundingClientRect();
      expect(
        Math.abs(block.getBoundingClientRect().left - lane.left - item.start * ppf),
      ).toBeLessThan(0.5);
    }
  });
});
