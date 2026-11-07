// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Timeline time (S7V-033): every position is an integer frame at the document's rational `fps`,
 * as in `edit.json`. This replaces OpenCut's WASM `MediaTime` ticks. Seconds and pixels are only
 * derived for display, never stored, so a 3-hour edit has no float drift.
 */
import type { EditRational } from "@t3tools/contracts";

/** Frames per second as a float, for pixel and seconds maths only. */
export const fpsValue = (fps: EditRational): number => fps.num / fps.den;

/** The start of `frame` in seconds. */
export const secondsOfFrame = (frame: number, fps: EditRational): number =>
  (frame * fps.den) / fps.num;

/** The frame showing at `seconds`: the one whose span holds that time. */
export const frameAtSeconds = (seconds: number, fps: EditRational): number =>
  Math.floor((seconds * fps.num) / fps.den + 1e-9);

/** Frames in one second, rounded to the nearest whole frame (30 at 29.97). */
export const framesPerSecondRounded = (fps: EditRational): number => Math.round(fpsValue(fps));

/** 29.97 and 59.94 use SMPTE drop-frame timecode (media-standards.md). */
const isDropFrameRate = (fps: EditRational): boolean =>
  fps.den === 1001 && (fps.num === 30_000 || fps.num === 60_000);

export interface Timecode {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly frames: number;
  readonly dropFrame: boolean;
}

/**
 * The SMPTE timecode of `frame`. At 29.97 and 59.94 it is drop-frame: frame numbers 0 and 1 (0-3
 * at 59.94) are skipped at the start of every minute except each tenth, so the clock keeps to the
 * wall clock.
 */
export function timecodeOf(frame: number, fps: EditRational): Timecode {
  const base = framesPerSecondRounded(fps);
  const dropFrame = isDropFrameRate(fps);
  let count = Math.max(0, Math.trunc(frame));
  if (dropFrame) {
    const drop = base === 60 ? 4 : 2;
    const framesPer10Minutes = Math.round(fpsValue(fps) * 600);
    const framesPerMinute = base * 60 - drop;
    const tens = Math.floor(count / framesPer10Minutes);
    const rest = count % framesPer10Minutes;
    const extra = rest < drop ? 0 : drop * Math.floor((rest - drop) / framesPerMinute);
    count += drop * 9 * tens + extra;
  }
  const frames = count % base;
  const totalSeconds = Math.floor(count / base);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    frames,
    dropFrame,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `HH:MM:SS:FF`, or `HH:MM:SS;FF` for drop-frame rates. */
export function formatTimecode(frame: number, fps: EditRational): string {
  const code = timecodeOf(frame, fps);
  return `${pad(code.hours)}:${pad(code.minutes)}:${pad(code.seconds)}${code.dropFrame ? ";" : ":"}${pad(code.frames)}`;
}
