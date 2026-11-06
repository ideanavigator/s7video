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
  /**
   * What the edit plays of this media now, in document frames; missing when it is not placed.
   * The plan only cuts inside these ranges: it never brings back what an earlier edit removed.
   */
  readonly current?: ReadonlyArray<EditSourceRange>;
}

export type SilencePlan =
  | {
      readonly _tag: "planned";
      /** Keep ranges in document frames, in order, none touching. */
      readonly ranges: ReadonlyArray<EditSourceRange>;
      /** Places this plan cuts, and the document frames it removes, beyond the current edit. */
      readonly cuts: number;
      readonly removedFrames: number;
      readonly shortestFrames: number;
      /**
       * Requested keep ranges that would have been cut and play in the result. A part of a
       * request inside an earlier cut never counts.
       */
      readonly keptRequests: number;
      /** The parts of requested keeps that an earlier edit already cut (source frames, in order). */
      readonly alreadyCut: ReadonlyArray<FrameRange>;
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

/** Sorted, with overlapping or touching spans joined. */
function union(spans: ReadonlyArray<Span>): Span[] {
  const joined: Span[] = [];
  for (const [from, to] of [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = joined.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

const overlaps = (spans: ReadonlyArray<Span>, [from, to]: Span) =>
  spans.some(([start, end]) => start < to && end > from);

function subtractAll(spans: ReadonlyArray<Span>, removed: ReadonlyArray<Span>): Span[] {
  let rest = [...spans];
  for (const span of removed) rest = rest.flatMap((piece) => subtract(piece, span));
  return rest;
}

const total = (spans: ReadonlyArray<Span>) => spans.reduce((sum, [from, to]) => sum + to - from, 0);

/**
 * Keeps under `minimum` holding nothing protected join their cuts. One holding a word takes the
 * shorter neighbouring planned cut; one holding only requests grows just to `minimum` (shorter
 * side first; a whole neighbour if the rest would be under `minGap`). `fixed` is never given back.
 */
function enforceMinimum(
  cuts: ReadonlyArray<Span>,
  length: number,
  minimum: number,
  minGap: number,
  words: ReadonlyArray<Span>,
  requests: ReadonlyArray<Span>,
  fixed: ReadonlyArray<Span>,
): Span[] {
  let current = union(cuts);
  const settled = new Set<number>();
  for (;;) {
    const keeps = complement(current, length);
    if (keeps.length <= 1) return current;
    const short = keeps.find(([from, to]) => to - from < minimum && !settled.has(from));
    if (short === undefined) return current;
    const [from, to] = short;
    const holdsWord = overlaps(words, short);
    if (!holdsWord && !overlaps(requests, short)) {
      current = union([...current, short]);
      continue;
    }
    const before = current.findIndex(([, end]) => end === from);
    const after = current.findIndex(([start]) => start === to);
    // How far the keep may grow into each neighbour before it would reach an earlier removal.
    let leftEdge = from;
    let leftStart = from;
    if (before !== -1) {
      const [a] = current[before]!;
      leftStart = a;
      leftEdge = Math.max(
        a,
        ...fixed.filter(([f0, f1]) => f0 < from && f1 > a).map(([, f1]) => Math.min(f1, from)),
      );
    }
    let rightEdge = to;
    let rightEnd = to;
    if (after !== -1) {
      const [, b] = current[after]!;
      rightEnd = b;
      rightEdge = Math.min(
        b,
        ...fixed.filter(([f0, f1]) => f0 < b && f1 > to).map(([f0]) => Math.max(f0, to)),
      );
    }
    const left = from - leftEdge;
    const right = rightEdge - to;
    if (left === 0 && right === 0) {
      settled.add(from);
      continue;
    }
    const leftFirst = left > 0 && (right === 0 || left <= right);
    if (holdsWord) {
      current = subtractAll(current, [leftFirst ? [leftEdge, from] : [to, rightEdge]]);
      continue;
    }
    // Only the frames still missing, from one side; the loop comes back for the other side.
    const need = minimum - (to - from);
    const room = leftFirst ? left : right;
    const size = leftFirst ? from - leftStart : rightEnd - to;
    // A neighbour with no earlier cut in it is taken whole rather than left as a sliver.
    const grow =
      room === size && size - need > 0 && size - need < minGap ? room : Math.min(need, room);
    current = subtractAll(current, [leftFirst ? [from - grow, from] : [to, to + grow]]);
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

  // What already plays, as document spans, and the rest of the source as fixed cuts. Converted
  // inward, so the plan stays inside what plays now.
  const playing: Span[] = union(
    (input.current ?? [{ in: 0, duration: input.mediaFrames }]).map((range): Span => [
      range.in,
      Math.min(input.mediaFrames, range.in + range.duration),
    ]),
  );
  const fixed =
    input.current === undefined
      ? []
      : complement(
          playing.map(([from, to]): Span => [
            convertFrame(from, input.documentRate, input.sourceRate, true),
            convertFrame(to, input.documentRate, input.sourceRate, false),
          ]),
          length,
        );

  // The gaps between words, plus the lead-in and the tail.
  const gaps: Span[] = [];
  let spoken = 0;
  for (const [from, to] of words) {
    if (from > spoken) gaps.push([spoken, from]);
    spoken = Math.max(spoken, to);
  }
  if (spoken < length) gaps.push([spoken, length]);

  const planned: Span[] = [];
  for (const [from, to] of gaps) {
    if (to - from < minGap) continue;
    const cut: Span = [from === 0 ? 0 : from + air, to === length ? length : to - air];
    if (cut[1] <= cut[0]) continue;
    if (meanLevel(input.levels, [cut]) <= quietBelow) planned.push(cut);
  }
  let cuts = enforceMinimum([...planned, ...fixed], length, minSegment, minGap, words, [], fixed);
  const before = subtractAll(cuts, fixed);

  const asked = input.keep
    .map(({ fromFrame, toFrame }): Span => [Math.max(0, fromFrame), Math.min(length, toFrame)])
    .filter(([from, to]) => to > from);
  // The tool only cuts more: a requested part inside an earlier cut stays cut and is reported.
  const alreadyCut = union(
    asked.flatMap(([from, to]) =>
      fixed.flatMap(([start, end]): Span[] => [[Math.max(from, start), Math.min(to, end)]]),
    ),
  );
  const pieces = asked.map((range) => subtractAll([range], fixed));
  const requests = pieces.flat();
  if (requests.length > 0) {
    let mine = before;
    for (const range of requests) {
      // What is left of a cut beside a kept pause is cut only if it is still a pause by itself.
      mine = mine.flatMap((cut) => {
        const pieces = subtract(cut, range);
        return pieces.length === 1 && pieces[0] === cut
          ? [cut]
          : pieces.filter(([from, to]) => to - from >= minGap);
      });
    }
    cuts = enforceMinimum([...mine, ...fixed], length, minSegment, minGap, words, requests, fixed);
  }
  const after = subtractAll(cuts, fixed);
  const keptRequests = pieces.filter(
    (parts) =>
      parts.some((range) => overlaps(before, range)) &&
      !parts.some((range) => overlaps(after, range)),
  ).length;

  // To document frames: keeps round outward, so no word or air is lost to rounding; then they
  // are held to what plays now.
  const outward = complement(cuts, length).map(([from, to]): Span => [
    convertFrame(from, input.sourceRate, input.documentRate, false),
    convertFrame(to, input.sourceRate, input.documentRate, true),
  ]);
  const kept = union(outward).flatMap(([from, to]) =>
    playing.flatMap(([start, end]): Span[] => {
      const span: Span = [Math.max(from, start), Math.min(to, end)];
      return span[1] > span[0] ? [span] : [];
    }),
  );
  const ranges = union(kept).map(([from, to]) => ({ in: from, duration: to - from }));
  if (ranges.length === 0) return { _tag: "no-speech" };

  const removed = subtractAll(playing, union(kept));
  return {
    _tag: "planned",
    ranges,
    cuts: union(removed).length,
    removedFrames: total(removed),
    shortestFrames: Math.min(...ranges.map((range) => range.duration)),
    keptRequests,
    alreadyCut: alreadyCut.map(([fromFrame, toFrame]) => ({ fromFrame, toFrame })),
  };
}
