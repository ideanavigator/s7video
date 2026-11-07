// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Frame pacing for the timeline perf tests (S7V-033, spike B1's recorder): the gap between
 * consecutive animation frames. At 60 fps a frame counts as dropped when a gap exceeds 25 ms
 * (1.5 × 16.7 ms). Long animation frames are counted from the browser's own observer.
 */
export interface FramePacing {
  readonly frames: number;
  readonly dropped: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly medianMs: number;
  readonly longAnimationFrames: number;
}

const DROPPED_GAP_MS = 25;

export function recordFramePacing(): { readonly stop: () => FramePacing } {
  const gaps: number[] = [];
  let last: number | null = null;
  let running = true;
  let longFrames = 0;
  const observer =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")
      ? new PerformanceObserver((list) => {
          longFrames += list.getEntries().length;
        })
      : null;
  observer?.observe({ type: "long-animation-frame" });
  const tick = (time: number) => {
    if (!running) return;
    if (last !== null) gaps.push(time - last);
    last = time;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop: () => {
      running = false;
      observer?.disconnect();
      const sorted = gaps.toSorted((a, b) => a - b);
      const at = (fraction: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
      return {
        frames: gaps.length,
        dropped: gaps.filter((gap) => gap > DROPPED_GAP_MS).length,
        p99Ms: at(0.99),
        maxMs: sorted.at(-1) ?? 0,
        medianMs: at(0.5),
        longAnimationFrames: longFrames,
      };
    },
  };
}

/** Milliseconds from `start` to the first frame painted after it settles. */
export async function timeToPaint(start: () => Promise<void>): Promise<number> {
  const begin = performance.now();
  await start();
  await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  return performance.now() - begin;
}

/** Lets the page sit for `ms` of real time, for idle and playback measurements. */
export const idleFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The next painted frame, for settling layout between perf runs. */
export const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
