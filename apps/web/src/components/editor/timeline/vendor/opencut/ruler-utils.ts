// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), file apps/web/src/timeline/ruler-utils.ts. Copied for S7V-033 from the spike B1 copies.
 *
 * Copyright 2025-2026 OpenCut
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * s7video changes: FrameRate -> EditRational, zoomLevel -> pixelsPerSecond, no opencut-wasm or @/fps imports.
 */

import type { EditRational as FrameRate } from "@t3tools/contracts";

const frameRateToFloat = (r: FrameRate) => r.num / r.den;

/**
 * frame intervals for labels - starts at 2 so there's always at least
 * one tick between labels even at max zoom.
 * pattern: 2, 3, 5, 10, 15 (matches CapCut)
 */
const LABEL_FRAME_INTERVALS = [2, 3, 5, 10, 15] as const;

/**
 * frame intervals for ticks - can go down to 1 for max granularity.
 */
const TICK_FRAME_INTERVALS = [1, 2, 3, 5, 10, 15] as const;

/**
 * second intervals for when we're zoomed out past frame-level detail.
 */
const SECOND_MULTIPLIERS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] as const;

/**
 * minimum pixel spacing between labels to keep them readable
 */
const MIN_LABEL_SPACING_PX = 120;

/**
 * minimum pixel spacing between ticks. much denser than labels.
 */
const MIN_TICK_SPACING_PX = 18;

export interface RulerConfig {
  /** time interval in seconds between each label */
  labelIntervalSeconds: number;
  /** time interval in seconds between each tick */
  tickIntervalSeconds: number;
}

/**
 * determines the optimal label and tick intervals based on zoom level and FPS. labels need wide
 * spacing to stay readable; ticks can be denser. very zoomed in: labels every 2f, ticks every 1f;
 * very zoomed out: labels every 1s, ticks every 5f. (s7video: example list shortened.)
 */
export function getRulerConfig({
  pixelsPerSecond,
  fps,
}: {
  pixelsPerSecond: number;
  fps: FrameRate;
}): RulerConfig {
  const fpsFloat = frameRateToFloat(fps);

  const pixelsPerFrame = pixelsPerSecond / fpsFloat;

  const labelIntervalSeconds = findOptimalInterval({
    pixelsPerFrame,
    pixelsPerSecond,
    fps: fpsFloat,
    minSpacingPx: MIN_LABEL_SPACING_PX,
    frameIntervals: LABEL_FRAME_INTERVALS,
  });

  const rawTickIntervalSeconds = findOptimalInterval({
    pixelsPerFrame,
    pixelsPerSecond,
    fps: fpsFloat,
    minSpacingPx: MIN_TICK_SPACING_PX,
    frameIntervals: TICK_FRAME_INTERVALS,
  });

  // ensure tick interval divides evenly into label interval so labels always land on ticks
  const tickIntervalSeconds = ensureTickDividesLabel({
    tickIntervalSeconds: rawTickIntervalSeconds,
    labelIntervalSeconds,
    pixelsPerFrame,
    pixelsPerSecond,
    fps: fpsFloat,
  });

  return { labelIntervalSeconds, tickIntervalSeconds };
}

/**
 * adjusts tick interval to ensure it divides evenly into the label interval.
 * this guarantees labels always land on tick positions.
 */
function ensureTickDividesLabel({
  tickIntervalSeconds,
  labelIntervalSeconds,
  pixelsPerFrame,
  pixelsPerSecond,
  fps,
}: {
  tickIntervalSeconds: number;
  labelIntervalSeconds: number;
  pixelsPerFrame: number;
  pixelsPerSecond: number;
  fps: number;
}): number {
  const labelFrames = Math.round(labelIntervalSeconds * fps);
  const tickFrames = Math.round(tickIntervalSeconds * fps);

  // if tick already divides label evenly, we're good
  if (labelFrames % tickFrames === 0) {
    return tickIntervalSeconds;
  }

  // find the smallest tick interval that divides the label interval and has adequate spacing
  for (const candidateFrames of TICK_FRAME_INTERVALS) {
    if (labelFrames % candidateFrames === 0) {
      const candidateSpacing = pixelsPerFrame * candidateFrames;
      // accept if spacing meets minimum threshold
      if (candidateSpacing >= MIN_TICK_SPACING_PX) {
        return candidateFrames / fps;
      }
    }
  }

  // try second-level tick intervals that divide the label interval cleanly
  for (const candidateSeconds of SECOND_MULTIPLIERS) {
    const ratio = labelIntervalSeconds / candidateSeconds;
    const isDivisor = Math.abs(ratio - Math.round(ratio)) < 0.0001;
    if (isDivisor) {
      const candidateSpacing = pixelsPerSecond * candidateSeconds;
      if (candidateSpacing >= MIN_TICK_SPACING_PX) {
        return candidateSeconds;
      }
    }
  }

  // fallback: use the label interval itself (no intermediate ticks)
  return labelIntervalSeconds;
}

function findOptimalInterval({
  pixelsPerFrame,
  pixelsPerSecond,
  fps,
  minSpacingPx,
  frameIntervals,
}: {
  pixelsPerFrame: number;
  pixelsPerSecond: number;
  fps: number;
  minSpacingPx: number;
  frameIntervals: readonly number[];
}): number {
  // try frame-level intervals first
  for (const frameInterval of frameIntervals) {
    const pixelSpacing = pixelsPerFrame * frameInterval;
    if (pixelSpacing >= minSpacingPx) {
      return frameInterval / fps;
    }
  }

  // then try second-level intervals
  for (const secondMultiplier of SECOND_MULTIPLIERS) {
    const pixelSpacing = pixelsPerSecond * secondMultiplier;
    if (pixelSpacing >= minSpacingPx) {
      return secondMultiplier;
    }
  }

  return 60;
}

/**
 * checks if a time should have a label based on the label interval.
 */
export function shouldShowLabel({
  time,
  labelIntervalSeconds,
}: {
  time: number;
  labelIntervalSeconds: number;
}): boolean {
  const epsilon = 0.0001;
  const remainder = time % labelIntervalSeconds;
  return remainder < epsilon || remainder > labelIntervalSeconds - epsilon;
}

/**
 * formats a ruler tick label.
 *
 * - on second boundaries: "MM:SS" (e.g., "00:00", "01:30")
 * - between seconds: "Xf" (e.g., "5f", "15f")
 */
export function formatRulerLabel({
  timeInSeconds,
  fps,
}: {
  timeInSeconds: number;
  fps: FrameRate;
}): string {
  if (isSecondBoundary({ timeInSeconds })) {
    return formatTimestamp({ timeInSeconds });
  }

  const frameWithinSecond = getFrameWithinSecond({ timeInSeconds, fps: frameRateToFloat(fps) });
  return `${frameWithinSecond}f`;
}

/**
 * checks if a time falls exactly on a second boundary.
 */
function isSecondBoundary({ timeInSeconds }: { timeInSeconds: number }): boolean {
  const epsilon = 0.0001;
  const remainder = timeInSeconds % 1;
  return remainder < epsilon || remainder > 1 - epsilon;
}

/**
 * gets the frame number within the current second.
 */
function getFrameWithinSecond({
  timeInSeconds,
  fps,
}: {
  timeInSeconds: number;
  fps: number;
}): number {
  const fractionalPart = timeInSeconds % 1;
  return Math.round(fractionalPart * fps);
}

/**
 * formats a timestamp as MM:SS or H:MM:SS when >= 1 hour.
 */
function formatTimestamp({ timeInSeconds }: { timeInSeconds: number }): string {
  const totalSeconds = Math.round(timeInSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = minutes.toString().padStart(2, "0");
  const ss = seconds.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}
