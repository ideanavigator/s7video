// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The spike B1 performance harness as a test (S7V-033): a generated 1,000-clip, 5-track edit,
 * scrolled end to end and back with a real compositor scroll gesture, and zoomed all the way in
 * and out with ctrl + wheel. Fails on any dropped frame while scrolling, or more than one per zoom.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { commands, page } from "vite-plus/test/browser";

import { itemCountOf, makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import {
  idleFor,
  nextPaint,
  recordCoverage,
  recordFramePacing,
  timeToPaint,
} from "../../../../test/framePacing";
import { render } from "../../../../test/render";

import "../../../index.css";

import { brandThemeTokenVariables } from "../../../themePalette";
import { Timeline } from "./Timeline";

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
    /** Defined in vite.config.ts: CDP input and CPU throttling at test-frame coordinates. */
    cdpInput: (input: CdpInput) => Promise<void>;
  }
}

const PROJECT_KEY = "env-perf:project-perf";
const edit = makePerfEdit(1_000);

async function mountPerfTimeline() {
  // The app sets the track colours at start-up; without them clips would paint transparent.
  for (const [name, value] of Object.entries(brandThemeTokenVariables("dark"))) {
    document.documentElement.style.setProperty(name, value);
  }
  const container = document.createElement("div");
  container.style.cssText = "width: 1112px; height: 240px; display: flex; flex-direction: column;";
  document.body.append(container);
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  const initialRenderMs = await timeToPaint(async () => {
    screen = await render(
      <Timeline
        projectKey={PROJECT_KEY}
        document={edit}
        playheadVisible
        initialFrame={0}
        onSeek={() => {}}
      />,
      { container, router: false },
    );
  });
  const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
  return { screen: screen!, scroller, initialRenderMs };
}

const centerOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.6 };
};

async function scrollSweep(scroller: HTMLDivElement) {
  const { x, y } = centerOf(scroller);
  const distance = scroller.scrollWidth - scroller.clientWidth;
  const pacing = recordFramePacing();
  const coverage = recordCoverage(scroller);
  // Synthesized gestures scroll content left for a negative distance: start to end, then back.
  await commands.cdpInput({ kind: "scroll", x, y, xDistance: -distance, speed: 4_000 });
  const reachedEnd = scroller.scrollLeft >= distance - 2;
  await commands.cdpInput({ kind: "scroll", x, y, xDistance: distance, speed: 4_000 });
  const result = pacing.stop();
  return { ...result, coverage: coverage.stop(), reachedEnd, endScrollLeft: scroller.scrollLeft };
}

async function zoomGesture(
  scroller: HTMLDivElement,
  direction: "in" | "out",
  anchor: number,
  count: number,
) {
  const rect = scroller.getBoundingClientRect();
  const x = rect.left + 112 + (rect.width - 112) * anchor;
  const y = rect.top + rect.height / 2;
  const pacing = recordFramePacing();
  const coverage = recordCoverage(scroller);
  await commands.cdpInput({
    kind: "ctrlWheel",
    x,
    y,
    deltaY: direction === "in" ? -60 : 60,
    count,
    intervalMs: 16,
  });
  await nextPaint();
  return {
    ...pacing.stop(),
    coverage: coverage.stop(),
    pxPerFrame: Number(scroller.dataset.pxPerFrame),
  };
}

describe("Timeline performance (1,000 clips, 5 tracks)", () => {
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- measures 5 s of idle and about 20 s of real scroll and zoom gestures; there is no milestone to await instead
  it("renders, idles, scrolls and zooms inside the frame budget", async () => {
    expect(itemCountOf(edit)).toBeGreaterThanOrEqual(1_000);
    await page.viewport(1_200, 600);
    const { screen, scroller, initialRenderMs } = await mountPerfTimeline();
    await using _screen = screen;
    const mountedClips = scroller.querySelectorAll("[data-timeline-item]").length;

    // AC-8: nothing is scheduled while paused.
    let scheduled = 0;
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      scheduled += 1;
      return realRaf(callback);
    };
    await idleFor(5_000);
    globalThis.requestAnimationFrame = realRaf;

    // About 2 px per frame, as in spike B1: the 3-minute edit is 10,800 px wide.
    const toScrollZoom = await zoomGesture(scroller, "in", 0.5, 13);
    const scroll = await scrollSweep(scroller);
    // AC-4: one gesture all the way in, one all the way out, at different anchors.
    const zoomIn = await zoomGesture(scroller, "in", 0.8, 30);
    const zoomOut = await zoomGesture(scroller, "out", 0.2, 45);

    await commands.cdpInput({ kind: "throttle", rate: 4 });
    onTestFinished(() => commands.cdpInput({ kind: "throttle", rate: 1 }));
    await zoomGesture(scroller, "in", 0.5, 13);
    const throttledScroll = await scrollSweep(scroller);
    const throttledZoomIn = await zoomGesture(scroller, "in", 0.8, 30);
    const throttledZoomOut = await zoomGesture(scroller, "out", 0.2, 45);
    await commands.cdpInput({ kind: "throttle", rate: 1 });

    const report = {
      initialRenderMs: Math.round(initialRenderMs),
      mountedClips,
      idleAnimationFramesScheduled: scheduled,
      toScrollZoom,
      scroll,
      zoomIn,
      zoomOut,
      throttled4x: { scroll: throttledScroll, zoomIn: throttledZoomIn, zoomOut: throttledZoomOut },
    };
    console.info(`S7V-033 timeline perf: ${JSON.stringify(report)}`);

    expect(initialRenderMs).toBeLessThanOrEqual(100);
    expect(scheduled).toBe(0);
    expect(scroll.reachedEnd).toBe(true);
    // The synthesized gesture lands within a few percent of where it started.
    expect(scroll.endScrollLeft).toBeLessThan(0.05 * 10_800);
    expect(scroll.dropped).toBe(0);
    for (const gesture of [toScrollZoom, zoomIn, zoomOut])
      expect(gesture.dropped).toBeLessThanOrEqual(1);
    // The mounted clips cover the screen on every frame of the scroll and the zoom sweeps.
    expect(scroll.coverage.frames).toBeGreaterThan(100);
    for (const run of [scroll, zoomIn, zoomOut]) expect(run.coverage.uncovered).toBe(0);
    // 4x throttle stands in for the M1 Air floor, loosely: CPU throttling slows script, style and
    // layout but not the GPU or a 60 Hz panel, and this runs React's development build, so the
    // bound catches a regression, not the PO's on-device check (docs/internals/timeline.md).
    expect(throttledScroll.dropped).toBeLessThanOrEqual(3);
    for (const gesture of [throttledZoomIn, throttledZoomOut])
      expect(gesture.dropped).toBeLessThanOrEqual(3);
  }, 90_000);
});
