// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Ruler ticks for the visible window (S7V-033), spaced by OpenCut's interval picker
 * (`vendor/opencut/ruler-utils.ts`). Below a second, ticks and labels follow the timecode's frame
 * field, so at 29.97 and 59.94 they stay on drop-frame frame numbers; from a second up they are
 * on whole seconds.
 */
import type { EditRational } from "@t3tools/contracts";

import { fpsValue, framesPerSecondRounded, timecodeOf } from "./mediaTime";
import { formatRulerLabel, getRulerConfig, shouldShowLabel } from "./vendor/opencut/ruler-utils";

export interface RulerTick {
  /** Lane pixel. */
  readonly x: number;
  /** Present on labelled ticks. */
  readonly label?: string;
}

export function rulerTicks(input: {
  readonly startPx: number;
  readonly endPx: number;
  readonly pxPerFrame: number;
  readonly fps: EditRational;
  /** Ticks stop at the content's end. */
  readonly endFrame: number;
}): RulerTick[] {
  const { startPx, endPx, pxPerFrame, fps } = input;
  const rate = fpsValue(fps);
  const pixelsPerSecond = pxPerFrame * rate;
  const config = getRulerConfig({ pixelsPerSecond, fps });
  const ticks: RulerTick[] = [];
  const lastFrame = Math.min(input.endFrame, Math.ceil(endPx / pxPerFrame));
  if (config.tickIntervalSeconds < 1) {
    const base = framesPerSecondRounded(fps);
    const tickFrames = Math.max(1, Math.round(config.tickIntervalSeconds * rate));
    const labelFrames = Math.max(1, Math.round(config.labelIntervalSeconds * rate));
    for (let frame = Math.max(0, Math.floor(startPx / pxPerFrame)); frame <= lastFrame; frame++) {
      const code = timecodeOf(frame, fps);
      const field = code.frames;
      if (field % tickFrames !== 0) continue;
      const second = code.hours * 3600 + code.minutes * 60 + code.seconds;
      const labelSeconds = Math.max(1, Math.round(config.labelIntervalSeconds));
      const labelled =
        labelFrames >= base
          ? field === 0 && second % labelSeconds === 0
          : field % labelFrames === 0;
      const x = frame * pxPerFrame;
      if (!labelled) ticks.push({ x });
      else if (field === 0) {
        ticks.push({ x, label: formatRulerLabel({ timeInSeconds: second, fps }) });
      } else ticks.push({ x, label: `${field}f` });
    }
    return ticks;
  }
  const step = config.tickIntervalSeconds;
  const lastSecond = lastFrame / rate;
  for (let index = Math.max(0, Math.floor(startPx / pixelsPerSecond / step)); ; index++) {
    const seconds = index * step;
    if (seconds > lastSecond) break;
    const x = seconds * pixelsPerSecond;
    ticks.push(
      shouldShowLabel({ time: seconds, labelIntervalSeconds: config.labelIntervalSeconds })
        ? { x, label: formatRulerLabel({ timeInSeconds: seconds, fps }) }
        : { x },
    );
  }
  return ticks;
}
