// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Waveforms and filmstrips in the real timeline (S7V-035): the slot draws them from the live view,
 * and AC-7: scrolling and zooming a 30-minute edit whose clips all show media data runs no
 * main-thread task over 50 ms. Media data is synthetic (test/fixtures/timeline/mediaData.ts).
 */
import { type AssetResource, type MediaAsset } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { commands, page } from "vite-plus/test/browser";

import "../../../index.css";

import { makeMediaDataServer } from "../../../../test/fixtures/timeline/mediaData";
import { itemCountOf, makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import { nextPaint, recordCoverage, recordFramePacing } from "../../../../test/framePacing";
import { render } from "../../../../test/render";
import { brandThemeTokenVariables } from "../../../themePalette";

type CdpInput =
  | { readonly kind: "throttle"; readonly rate: number }
  | {
      readonly kind: "scroll";
      readonly x: number;
      readonly y: number;
      readonly xDistance: number;
      readonly speed: number;
    }
  | {
      readonly kind: "ctrlWheel";
      readonly x: number;
      readonly y: number;
      readonly deltaY: number;
      readonly count: number;
      readonly intervalMs: number;
    };

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    cdpInput: (input: CdpInput) => Promise<void>;
  }
}

const serve = makeMediaDataServer();
const minted: AssetResource[] = [];

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlMinter: () => async (resource: AssetResource) => {
    minted.push(resource);
    return (await serve(resource)) ?? null;
  },
}));

const { Timeline } = await import("./Timeline");
const { mediaTilesWorker } = await import("./ClipMediaTiles");

// 30 minutes at 30 fps, every video, SFX and music item cut from one clip with sound and picture.
const edit = makePerfEdit(300, 30 * 60 * 30);
const asset = {
  id: "synth",
  kind: "video",
  label: "testsrc2.mp4",
  storage: "reference",
  location: "/synthetic/testsrc2.mp4",
  state: "ready",
  sizeBytes: 1,
  durationFrames: 54_000,
  fps: { num: 30, den: 1 },
  hasVideo: true,
  hasAudio: true,
  hasThumbnail: false,
  proxy: { status: "none" },
  mediaData: { status: "ready", peaks: "ready", filmstrip: "ready" },
} satisfies MediaAsset;

const draws = { all: 0, complete: 0 };

async function mountTimeline() {
  for (const [name, value] of Object.entries(brandThemeTokenVariables("dark"))) {
    document.documentElement.style.setProperty(name, value);
  }
  const worker = mediaTilesWorker()!;
  const listener = (_id: string, complete: boolean) => {
    draws.all += 1;
    if (complete) draws.complete += 1;
  };
  worker.drawn.add(listener);
  onTestFinished(() => void worker.drawn.delete(listener));
  const container = document.createElement("div");
  container.style.cssText = "width: 1112px; height: 240px; display: flex; flex-direction: column;";
  document.body.append(container);
  const screen = await render(
    <Timeline
      projectKey="env-1:project-1"
      document={edit}
      playheadVisible
      initialFrame={0}
      onSeek={() => {}}
      projectRef={{ environmentId: "env-1" as never, projectId: "project-1" as never }}
      mediaById={new Map([["synth", asset]])}
    />,
    { container, router: false },
  );
  const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
  return { screen, scroller };
}

const canvasesOf = (scroller: HTMLElement, variant: "peaks" | "filmstrip") =>
  scroller.querySelectorAll(`canvas[data-media-tiles=${variant}]`).length;

async function zoom(
  scroller: HTMLDivElement,
  direction: "in" | "out",
  anchor: number,
  count: number,
) {
  const rect = scroller.getBoundingClientRect();
  await commands.cdpInput({
    kind: "ctrlWheel",
    x: rect.left + 112 + (rect.width - 112) * anchor,
    y: rect.top + rect.height / 2,
    deltaY: direction === "in" ? -60 : 60,
    count,
    intervalMs: 16,
  });
  await nextPaint();
}

describe("ClipMediaSlot in the timeline", () => {
  it("draws filmstrips and waveforms that follow the view, under each clip's label", async () => {
    await page.viewport(1_200, 600);
    const { screen, scroller } = await mountTimeline();
    await using _screen = screen;
    await vi.waitFor(() => expect(draws.complete).toBeGreaterThan(0));
    // Video items show a filmstrip and a waveform; SFX and music only a waveform; text nothing.
    expect(canvasesOf(scroller, "filmstrip")).toBeGreaterThan(0);
    expect(canvasesOf(scroller, "peaks")).toBeGreaterThan(canvasesOf(scroller, "filmstrip"));
    const textItems = scroller.querySelectorAll(
      "[data-timeline-item^=caption-] canvas, [data-timeline-item^=overlay-] canvas",
    );
    expect(textItems.length).toBe(0);
    // Only the media parts in view were asked for, never a whole level list.
    expect(minted.length).toBeLessThan(40);

    // Each layer covers its clip's visible part: source frames at the edit's rate, as wide as
    // they are at the current zoom, which reaches the slots without re-rendering every clip.
    const layersMatchZoom = () => {
      const pxPerFrame = Number(scroller.dataset.pxPerFrame);
      const layers = [...scroller.querySelectorAll<HTMLElement>("[data-clip-media-span]")];
      expect(layers.length).toBeGreaterThan(0);
      for (const layer of layers) {
        const [first, end] = layer.dataset.clipMediaSpan!.split("-").map(Number);
        const canvas = layer.querySelector("canvas")!;
        expect(Math.abs((end! - first!) * pxPerFrame - canvas.clientWidth)).toBeLessThanOrEqual(2);
      }
    };
    const zoomBefore = Number(scroller.dataset.pxPerFrame);
    layersMatchZoom();
    await zoom(scroller, "in", 0.5, 10);
    await vi.waitFor(() => {
      expect(Number(scroller.dataset.pxPerFrame)).toBeGreaterThan(zoomBefore * 1.5);
      layersMatchZoom();
    });
    // The media layer sits below the label inside the block.
    const layer = scroller.querySelector<HTMLElement>("[data-clip-media-span]")!;
    expect(getComputedStyle(layer).zIndex).toBe("-10");
  });

  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- runs about 20 s of real scroll and zoom gestures; there is no milestone to await instead
  it("AC-7: scrolling and zooming 30 minutes of media data runs no main-thread task over 50 ms", async () => {
    expect(itemCountOf(edit)).toBeGreaterThanOrEqual(300);
    await page.viewport(1_200, 600);
    const { screen, scroller } = await mountTimeline();
    await using _screen = screen;
    await vi.waitFor(() => expect(draws.complete).toBeGreaterThan(0));
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    observer.observe({ type: "longtask", buffered: false });
    onTestFinished(() => observer.disconnect());
    const drawsBefore = draws.all;

    // Each gesture timed on its own, as Timeline.perf does, so its per-gesture bounds apply.
    const timed = async (gesture: () => Promise<void>) => {
      const pacing = recordFramePacing();
      await gesture();
      return pacing.stop();
    };
    const coverage = recordCoverage(scroller);
    // Into about 2 px per frame, across a quarter of the edit and back, then all the way in and out.
    const toScroll = await timed(() => zoom(scroller, "in", 0.5, 13));
    const rect = scroller.getBoundingClientRect();
    const distance = scroller.scrollWidth - scroller.clientWidth;
    const at = { x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.6 };
    const scroll = await timed(async () => {
      await commands.cdpInput({ kind: "scroll", ...at, xDistance: -distance / 4, speed: 4_000 });
      await commands.cdpInput({ kind: "scroll", ...at, xDistance: distance / 4, speed: 4_000 });
    });
    const zoomIn = await timed(() => zoom(scroller, "in", 0.8, 30));
    const zoomOut = await timed(() => zoom(scroller, "out", 0.2, 45));
    const covered = coverage.stop();
    observer.disconnect();

    const report = {
      longTasksMs: longTasks,
      draws: draws.all - drawsBefore,
      canvases: canvasesOf(scroller, "peaks") + canvasesOf(scroller, "filmstrip"),
      dropped: {
        toScroll: toScroll.dropped,
        scroll: scroll.dropped,
        zoomIn: zoomIn.dropped,
        zoomOut: zoomOut.dropped,
      },
      coverage: covered,
    };
    console.info(`S7V-035 AC-7 media tiles perf: ${JSON.stringify(report)}`);
    expect(report.draws).toBeGreaterThan(50);
    expect(longTasks.filter((duration) => duration > 50)).toEqual([]);
    // Timeline.perf's frame budget: no dropped frame while scrolling, at most one per zoom gesture.
    expect(scroll.dropped).toBe(0);
    for (const gesture of [toScroll, zoomIn, zoomOut])
      expect(gesture.dropped).toBeLessThanOrEqual(1);
    // React's clip window may trail the view on a few frames while 120 worker canvases redraw
    // each frame (2 to 6 of about 520 measured, 0 to 2 without media data;
    // docs/internals/timeline.md); 8 is the budget for one sweep.
    expect(covered.uncovered).toBeLessThanOrEqual(8);
  }, 90_000);
});
