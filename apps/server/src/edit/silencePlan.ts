// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Silence removal as a pure plan (S7V-027): transcript words and per-frame sound levels in, keep
// ranges in document frames out. Pauses come from the gaps between words; a gap is cut only when
// its sound is quiet next to the clip's own speech, so laughter or music between words stays.
import type { EditRational, EditSourceRange } from "@t3tools/contracts";

/** Air kept before and after every word. */
export const AIR_SECONDS = 0.1;
/** No kept segment is shorter than this. */
export const MIN_SEGMENT_SECONDS = 0.3;
export const DEFAULT_MIN_GAP_SECONDS = 0.4;
/** A gap is quiet when its sound is at least this far below the clip's speech level. */
export const QUIET_MARGIN_DB = 6;

export interface FrameRange {
  /** First frame. */
  readonly fromFrame: number;
  /** First frame after the range. */
  readonly toFrame: number;
}

export interface SilencePlanInput {
  /** Word spans in source frames (`endFrame` exclusive), from the transcript. */
  readonly words: ReadonlyArray<{ readonly startFrame: number; readonly endFrame: number }>;
  /** Sound level in dBFS of each source frame (`silence.detect`). */
  readonly levels: ReadonlyArray<number>;
  readonly sourceRate: EditRational;
  readonly sourceFrames: number;
  readonly documentRate: EditRational;
  /** The media's length in document frames. */
  readonly mediaFrames: number;
  readonly minGapSeconds: number;
  /** Source-frame ranges that must play, applied after every other rule. */
  readonly keep: ReadonlyArray<FrameRange>;
}

export type SilencePlan =
  | {
      readonly _tag: "planned";
      /** Keep ranges in document frames, in order, none touching. */
      readonly ranges: ReadonlyArray<EditSourceRange>;
      readonly cuts: number;
      readonly removedFrames: number;
      readonly shortestFrames: number;
      /** Requested keep ranges that stopped a cut. */
      readonly keptRequests: number;
    }
  | { readonly _tag: "no-speech" };

type Span = [number, number];

const secondsToFrames = (seconds: number, rate: EditRational) =>
  Math.round((seconds * rate.num) / rate.den);

/** `frame` at `from` as a frame at `to`, rounded down or up, in exact integer arithmetic. */
function convertFrame(frame: number, from: EditRational, to: EditRational, up: boolean): number {
  const numerator = BigInt(frame) * BigInt(to.num) * BigInt(from.den);
  const denominator = BigInt(to.den) * BigInt(from.num);
  const quotient = numerator / denominator;
  return Number(up && quotient * denominator < numerator ? quotient + 1n : quotient);
}

const power = (db: number) => 10 ** (db / 10);
const decibels = (meanPower: number) => (meanPower > 0 ? 10 * Math.log10(meanPower) : -Infinity);

function meanLevel(levels: ReadonlyArray<number>, spans: ReadonlyArray<Span>): number {
  let sum = 0;
  let count = 0;
  for (const [from, to] of spans) {
    for (let frame = Math.max(0, from); frame < Math.min(to, levels.length); frame++) {
      sum += power(levels[frame]!);
      count++;
    }
  }
  return count === 0 ? -Infinity : decibels(sum / count);
}

function subtract(span: Span, removed: Span): Span[] {
  const [from, to] = span;
  if (removed[1] <= from || removed[0] >= to) return [span];
  const left: Span[] = removed[0] > from ? [[from, removed[0]]] : [];
  const right: Span[] = removed[1] < to ? [[removed[1], to]] : [];
  return [...left, ...right];
}

function complement(cuts: ReadonlyArray<Span>, length: number): Span[] {
  const keeps: Span[] = [];
  let at = 0;
  for (const [from, to] of [...cuts].sort((x, y) => x[0] - y[0])) {
    if (from > at) keeps.push([at, from]);
    at = Math.max(at, to);
  }
  if (at < length) keeps.push([at, length]);
  return keeps;
}

/**
 * Keeps shorter than `minimum` are merged into the neighbour across the shorter cut, or dropped
 * when they hold no word. Returns the cuts that remain.
 */
function enforceMinimum(
  cuts: ReadonlyArray<Span>,
  length: number,
  minimum: number,
  words: ReadonlyArray<Span>,
): Span[] {
  let current = [...cuts].sort((x, y) => x[0] - y[0]);
  for (;;) {
    const keeps = complement(current, length);
    const index = keeps.findIndex(([from, to]) => to - from < minimum);
    if (index === -1 || keeps.length === 1) return current;
    const [from, to] = keeps[index]!;
    const before = current.findIndex(([, end]) => end === from);
    const after = current.findIndex(([start]) => start === to);
    if (!words.some(([start, end]) => start < to && end > from)) {
      // A keep without words: join the cuts on both sides through it.
      const start = before === -1 ? from : current[before]![0];
      const end = after === -1 ? to : current[after]![1];
      current = [
        ...current.filter((_, i) => i !== before && i !== after),
        [start, end] as Span,
      ].sort((x, y) => x[0] - y[0]);
      continue;
    }
    const size = (i: number) => (i === -1 ? Infinity : current[i]![1] - current[i]![0]);
    const drop = size(before) <= size(after) ? before : after;
    current = current.filter((_, i) => i !== drop);
  }
}

export function planSilenceCuts(input: SilencePlanInput): SilencePlan {
  const length = input.sourceFrames;
  const words = input.words
    .map(({ startFrame, endFrame }): Span => [startFrame, Math.min(endFrame, length)])
    .filter(([from, to]) => to > from)
    .sort((x, y) => x[0] - y[0]);
  if (words.length === 0) return { _tag: "no-speech" };

  const air = secondsToFrames(AIR_SECONDS, input.sourceRate);
  const minGap = Math.max(1, secondsToFrames(input.minGapSeconds, input.sourceRate));
  // Rounded up: at 23.976 fps, 7 frames would be 0.292 s.
  const minSegment = Math.ceil((MIN_SEGMENT_SECONDS * input.sourceRate.num) / input.sourceRate.den);
  const quietBelow = meanLevel(input.levels, words) - QUIET_MARGIN_DB;

  // The gaps between words, plus the lead-in and the tail.
  const gaps: Span[] = [];
  let spoken = 0;
  for (const [from, to] of words) {
    if (from > spoken) gaps.push([spoken, from]);
    spoken = Math.max(spoken, to);
  }
  if (spoken < length) gaps.push([spoken, length]);

  let cuts: Span[] = [];
  for (const [from, to] of gaps) {
    if (to - from < minGap) continue;
    const cut: Span = [from === 0 ? 0 : from + air, to === length ? length : to - air];
    if (cut[1] <= cut[0]) continue;
    if (meanLevel(input.levels, [cut]) <= quietBelow) cuts.push(cut);
  }
  cuts = enforceMinimum(cuts, length, minSegment, words);

  let keptRequests = 0;
  for (const { fromFrame, toFrame } of input.keep) {
    const range: Span = [Math.max(0, fromFrame), Math.min(length, toFrame)];
    if (range[1] <= range[0]) continue;
    if (cuts.some(([from, to]) => from < range[1] && to > range[0])) keptRequests++;
    // What is left of a cut beside a kept pause is cut only if it is still a pause by itself.
    cuts = cuts.flatMap((cut) => {
      const pieces = subtract(cut, range);
      return pieces.length === 1 && pieces[0] === cut
        ? [cut]
        : pieces.filter(([from, to]) => to - from >= minGap);
    });
  }
  if (input.keep.length > 0) cuts = enforceMinimum(cuts, length, minSegment, words);

  // To document frames: keeps round outward, so no word or air is lost to rounding.
  const ranges: EditSourceRange[] = [];
  for (const [from, to] of complement(cuts, length)) {
    const start = convertFrame(from, input.sourceRate, input.documentRate, false);
    const end = Math.min(
      input.mediaFrames,
      convertFrame(to, input.sourceRate, input.documentRate, true),
    );
    if (end <= start) continue;
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.in + last.duration) {
      ranges[ranges.length - 1] = { in: last.in, duration: end - last.in };
    } else {
      ranges.push({ in: start, duration: end - start });
    }
  }
  if (ranges.length === 0) return { _tag: "no-speech" };

  const kept = ranges.reduce((sum, range) => sum + range.duration, 0);
  const first = ranges[0]!;
  const final = ranges.at(-1)!;
  return {
    _tag: "planned",
    ranges,
    cuts:
      ranges.length -
      1 +
      (first.in > 0 ? 1 : 0) +
      (final.in + final.duration < input.mediaFrames ? 1 : 0),
    removedFrames: input.mediaFrames - kept,
    shortestFrames: Math.min(...ranges.map((range) => range.duration)),
    keptRequests,
  };
}
