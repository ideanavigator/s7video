// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A dev counter of the player's skips over cuts (S7V-029): how long each took from the seek to the
 * new frame on screen, how far it landed from the kept frame, and frames that froze or showed cut
 * material. The sprint's PM run reads it from the console in a dev build.
 */

export interface SkipSample {
  readonly ms: number;
  readonly landedOffFrames: number;
  readonly frozenFrames: number;
  readonly cutFramesShown: number;
}

export interface SkipSummary {
  readonly skips: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly maxLandedOffFrames: number;
  readonly skipsFrozenOverOneFrame: number;
  readonly cutFramesShown: number;
}

const MAX_SAMPLES = 1_000;
const samples: SkipSample[] = [];

export function recordSkip(sample: SkipSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

export function summarizeSkips(from: ReadonlyArray<SkipSample> = samples): SkipSummary {
  const times = from.map((sample) => sample.ms).toSorted((left, right) => left - right);
  const at = (fraction: number) =>
    times.length === 0
      ? 0
      : times[Math.min(times.length - 1, Math.floor(fraction * times.length))]!;
  return {
    skips: from.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: times.at(-1) ?? 0,
    maxLandedOffFrames: Math.max(0, ...from.map((sample) => Math.abs(sample.landedOffFrames))),
    skipsFrozenOverOneFrame: from.filter((sample) => sample.frozenFrames > 1).length,
    cutFramesShown: from.reduce((total, sample) => total + sample.cutFramesShown, 0),
  };
}

export function resetSkips(): void {
  samples.length = 0;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.assign(window, { s7videoSkips: { summary: summarizeSkips, reset: resetSkips } });
}
