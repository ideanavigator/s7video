// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Text edits (S7V-038), shared by the Transcript tab and the server: silence removal's rules
 * (S7V-027) for cut edges, a cut as split + ripple delete, a restore as `restoreRange`. Pure.
 */
import type { EditDocument, EditOp, EditRational } from "@t3tools/contracts";

/** Air kept before and after every kept word. */
export const AIR_SECONDS = 0.1;
/** No kept segment is shorter than this. */
export const MIN_SEGMENT_SECONDS = 0.3;

/** `seconds` as the nearest whole frame at `rate`. */
export const secondsToFrames = (seconds: number, rate: EditRational): number =>
  Math.round((seconds * rate.num) / rate.den);

/** The shortest kept segment, in frames, rounded up: at 23.976 fps, 7 frames would be 0.292 s. */
export const minSegmentFrames = (rate: EditRational): number =>
  Math.ceil((MIN_SEGMENT_SECONDS * rate.num) / rate.den);

/** `frame` at `from` as a frame at `to`, rounded down or up, in exact integer arithmetic. */
export function convertFrame(
  frame: number,
  from: EditRational,
  to: EditRational,
  up: boolean,
): number {
  const numerator = BigInt(frame) * BigInt(to.num) * BigInt(from.den);
  const denominator = BigInt(to.den) * BigInt(from.num);
  const quotient = numerator / denominator;
  return Number(up && quotient * denominator < numerator ? quotient + 1n : quotient);
}

/** Source frames `[from, to)`. */
export type FrameSpan = readonly [from: number, to: number];

/** A transcript word in source frames at the document fps, `end` exclusive. */
export interface WordSpan {
  readonly start: number;
  readonly end: number;
}

/** Sorted, with overlapping or touching spans joined. */
function union(spans: ReadonlyArray<FrameSpan>): FrameSpan[] {
  const joined: Array<[number, number]> = [];
  for (const [from, to] of [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = joined.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

/** `spans` with `removed` taken out; both sorted and disjoint. */
function subtract(spans: ReadonlyArray<FrameSpan>, removed: ReadonlyArray<FrameSpan>): FrameSpan[] {
  const rest: FrameSpan[] = [];
  for (const [from, to] of spans) {
    let at = from;
    for (const [start, end] of removed) {
      if (end <= at) continue;
      if (start >= to) break;
      if (start > at) rest.push([at, start]);
      at = Math.max(at, end);
    }
    if (at < to) rest.push([at, to]);
  }
  return rest;
}

/** The kept span with `from < frame < to`, by binary search over sorted, disjoint spans. */
function spanAround(kept: ReadonlyArray<FrameSpan>, frame: number): FrameSpan | undefined {
  let low = 0;
  let high = kept.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = kept[middle]!;
    if (frame <= span[0]) high = middle - 1;
    else if (frame >= span[1]) low = middle + 1;
    else return span;
  }
  return undefined;
}

/** True when some frame of `[from, to)` is kept. */
function anyKept(kept: ReadonlyArray<FrameSpan>, from: number, to: number): boolean {
  let low = 0;
  let high = kept.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (kept[middle]![1] <= from) low = middle + 1;
    else high = middle;
  }
  const span = kept[low];
  return span !== undefined && span[0] < to;
}

/** What the edit plays of `mediaId`: its video items' source spans, joined. */
export function keptSpansOf(document: EditDocument, mediaId: string): FrameSpan[] {
  const spans: FrameSpan[] = [];
  for (const track of document.tracks) {
    if (track.kind !== "video") continue;
    for (const item of track.items) {
      if (item.media === mediaId) spans.push([item.in, item.in + item.duration]);
    }
  }
  return union(spans);
}

/** The media's length in document frames: its probe, else the end of what plays of it. */
function mediaFramesOf(document: EditDocument, mediaId: string): number {
  const media = document.media.find((entry) => entry.id === mediaId);
  const probed = media?.probe?.durationFrames;
  if (probed !== undefined && probed > 0) return probed;
  return keptSpansOf(document, mediaId).at(-1)?.[1] ?? 0;
}

export interface WordEditInput {
  /** Every word of the clip, sorted by start. A word with `end <= start` is skipped. */
  readonly words: ReadonlyArray<WordSpan>;
  /** The selection, word indices `first..last` inclusive. */
  readonly first: number;
  readonly last: number;
  /** What plays of the clip now (`keptSpansOf`). */
  readonly kept: ReadonlyArray<FrameSpan>;
  /** The clip's length in document frames. */
  readonly mediaFrames: number;
  readonly fps: EditRational;
}

export interface WordCut {
  /** The source frames to remove; parts of it may already be cut. */
  readonly range: FrameSpan;
  /** The selected words that play now, which the cut removes. */
  readonly words: ReadonlyArray<number>;
  /**
   * Frames cut beyond the selection's gaps, so that no kept segment under the minimum is left
   * (0 when none). The UI says so.
   */
  readonly widenedFrames: number;
  /** Unselected words inside a too-short segment the cut also took. */
  readonly widenedWords: ReadonlyArray<number>;
}

const isTimed = (word: WordSpan | undefined): word is WordSpan =>
  word !== undefined && word.end > word.start;

/**
 * The cut for deleting the selected words: from the air after the last kept word before them to
 * the air before the first kept word after them, as silence removal cuts a pause (a selection at
 * the clip's start or end cuts to its edge). `null` when no selected word plays.
 */
export function planWordCut(input: WordEditInput): WordCut | null {
  const { words, kept } = input;
  const plays = (index: number) => {
    const word = words[index];
    return isTimed(word) && anyKept(kept, word.start, word.end);
  };
  const selected: number[] = [];
  for (let index = Math.max(0, input.first); index <= input.last; index += 1) {
    if (plays(index)) selected.push(index);
  }
  if (selected.length === 0) return null;
  const air = secondsToFrames(AIR_SECONDS, input.fps);
  const minimum = minSegmentFrames(input.fps);
  const start = words[selected[0]!]!.start;
  const end = Math.min(input.mediaFrames, Math.max(...selected.map((index) => words[index]!.end)));
  let before = input.first - 1;
  while (before >= 0 && !plays(before)) before -= 1;
  let after = input.last + 1;
  while (after < words.length && !plays(after)) after += 1;
  const previous = words[before];
  const next = words[after];
  let from = previous === undefined ? 0 : Math.max(0, Math.min(previous.end + air, start));
  let to =
    next === undefined
      ? input.mediaFrames
      : Math.max(end, Math.min(next.start - air, input.mediaFrames));
  if (to <= from) return null;

  let widenedFrames = 0;
  const widenedWords: number[] = [];
  /** Kept words (not selected) with a frame in `[a, b)`, scanning out from `index`. */
  const wordsIn = (a: number, b: number, index: number, step: 1 | -1) => {
    const found: number[] = [];
    for (let at = index; at >= 0 && at < words.length; at += step) {
      const word = words[at]!;
      if (step === -1 ? word.end <= a : word.start >= b) break;
      if (isTimed(word) && word.start < b && word.end > a && plays(at)) found.push(at);
    }
    return found;
  };
  // The kept segment left before the cut: too short, it either takes back silence from the cut or
  // goes with it.
  const left = spanAround(kept, from);
  if (left !== undefined && from - left[0] < minimum) {
    const length = from - left[0];
    const inside = wordsIn(left[0], from, before, -1);
    const give = Math.min(minimum - length, start - from);
    if (inside.length > 0 && length + give >= minimum) from += give;
    else {
      widenedFrames += length;
      widenedWords.push(...inside.reverse());
      from = left[0];
    }
  }
  const right = spanAround(kept, to);
  if (right !== undefined && right[1] - to < minimum) {
    const length = right[1] - to;
    const inside = wordsIn(to, right[1], after, 1);
    const give = Math.min(minimum - length, to - end);
    if (inside.length > 0 && length + give >= minimum) to -= give;
    else {
      widenedFrames += length;
      widenedWords.push(...inside);
      to = right[1];
    }
  }
  return { range: [from, to], words: selected, widenedFrames, widenedWords };
}

export interface WordRestore {
  /** The cut source frames to put back, sorted and disjoint. */
  readonly ranges: ReadonlyArray<FrameSpan>;
  /** The selected words that were cut, which the restore brings back. */
  readonly words: ReadonlyArray<number>;
}

/**
 * What restoring the selected words puts back: their frames and the gaps around them, the inverse
 * of `planWordCut`. Toward a kept word the whole gap comes back (the cut took it, so after a
 * silence cut the pause comes back too); toward a cut word only the air, so that word stays cut. A restored island is grown to the minimum segment
 * where the cut around it allows.
 */
export function planWordRestore(input: WordEditInput): WordRestore {
  const { words, kept } = input;
  const plays = (index: number) => {
    const word = words[index];
    return isTimed(word) && anyKept(kept, word.start, word.end);
  };
  const timed: number[] = [];
  for (let index = Math.max(0, input.first); index <= input.last; index += 1) {
    if (isTimed(words[index])) timed.push(index);
  }
  const restored = timed.filter((index) => !plays(index));
  if (restored.length === 0) return { ranges: [], words: [] };
  const air = secondsToFrames(AIR_SECONDS, input.fps);
  const minimum = minSegmentFrames(input.fps);
  const start = words[timed[0]!]!.start;
  const end = Math.min(input.mediaFrames, Math.max(...timed.map((index) => words[index]!.end)));
  let before = input.first - 1;
  while (before >= 0 && !isTimed(words[before])) before -= 1;
  let after = input.last + 1;
  while (after < words.length && !isTimed(words[after])) after += 1;
  const previous = words[before];
  const next = words[after];
  const from =
    previous === undefined
      ? 0
      : plays(before)
        ? Math.min(previous.end, start)
        : Math.min(start, Math.max(previous.end, start - air));
  const to =
    next === undefined
      ? input.mediaFrames
      : plays(after)
        ? Math.max(end, Math.min(next.start, input.mediaFrames))
        : Math.max(end, Math.min(next.start, end + air, input.mediaFrames));
  const floor = previous === undefined ? 0 : Math.min(previous.end, start);
  const ceiling = next === undefined ? input.mediaFrames : Math.max(next.start, end);
  const holes = subtract([[from, to]], kept);
  const grown = holes.map(([a, b]): FrameSpan => {
    const island = !anyKept(kept, a - 1, a) && !anyKept(kept, b, b + 1);
    if (!island || b - a >= minimum) return [a, b];
    // Half the missing frames on each side, the rest on the other, inside the gap around it.
    const need = minimum - (b - a);
    const leftRoom = Math.max(0, a - floor);
    const rightRoom = Math.max(0, ceiling - b);
    let growLeft = Math.min(leftRoom, Math.ceil(need / 2));
    const growRight = Math.min(rightRoom, need - growLeft);
    growLeft = Math.min(leftRoom, need - growRight);
    return [a - growLeft, b + growRight];
  });
  return { ranges: subtract(union(grown), kept), words: restored };
}

/** Ids this module gives the right-hand parts of a split; never one the server allocates. */
const PART_PREFIX = "vt";

function allIds(document: EditDocument): Set<string> {
  const ids = new Set<string>();
  for (const media of document.media) ids.add(media.id);
  for (const marker of document.markers) ids.add(marker.id);
  for (const track of document.tracks) {
    ids.add(track.id);
    for (const item of track.items) ids.add(item.id);
  }
  return ids;
}

/**
 * The ops that cut source frames `range` of `mediaId`: each video item under the cut is split at
 * its edges and its middle deleted with ripple, so later items on its track close up and every
 * other item keeps its place. Splits come first, so every frame is planned from `document`.
 */
export function wordCutOps(
  document: EditDocument,
  mediaId: string,
  range: FrameSpan,
): ReadonlyArray<EditOp> {
  const [from, to] = range;
  const taken = allIds(document);
  let counter = 0;
  const fresh = () => {
    let id: string;
    do id = `${PART_PREFIX}${(counter += 1)}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
  const splits: EditOp[] = [];
  const deleted: string[] = [];
  for (const track of document.tracks) {
    if (track.kind !== "video") continue;
    for (const item of [...track.items].sort((a, b) => a.start - b.start)) {
      if (item.media !== mediaId) continue;
      const itemEnd = item.in + item.duration;
      const cutFrom = Math.max(from, item.in);
      const cutTo = Math.min(to, itemEnd);
      if (cutTo <= cutFrom) continue;
      if (cutTo < itemEnd) {
        splits.push({
          _tag: "splitItem",
          itemId: item.id,
          atFrame: item.start + cutTo - item.in,
          newItemId: fresh(),
        });
      }
      if (cutFrom > item.in) {
        const middle = fresh();
        splits.push({
          _tag: "splitItem",
          itemId: item.id,
          atFrame: item.start + cutFrom - item.in,
          newItemId: middle,
        });
        deleted.push(middle);
      } else deleted.push(item.id);
    }
  }
  if (deleted.length === 0) return [];
  return [...splits, { _tag: "deleteItem", itemIds: deleted, ripple: true }];
}

/**
 * The ops that put back source frames `ranges` of `mediaId`: one `restoreRange` for each part that
 * is cut now, on the video track that plays its source neighbours (else the first that plays the
 * clip, else the first video track).
 */
export function wordRestoreOps(
  document: EditDocument,
  mediaId: string,
  ranges: ReadonlyArray<FrameSpan>,
): ReadonlyArray<EditOp> {
  const videoTracks = document.tracks.filter((track) => track.kind === "video");
  const ops: EditOp[] = [];
  for (const [from, to] of subtract(union(ranges), keptSpansOf(document, mediaId))) {
    const own = (track: (typeof videoTracks)[number]) =>
      track.items.filter((item) => item.media === mediaId);
    const track =
      videoTracks.find((entry) =>
        own(entry).some((item) => item.in + item.duration === from || item.in === to),
      ) ??
      videoTracks.find((entry) => own(entry).length > 0) ??
      videoTracks[0];
    if (track === undefined) continue;
    ops.push({
      _tag: "restoreRange",
      trackId: track.id,
      mediaId,
      range: { in: from, duration: to - from },
    });
  }
  return ops;
}

export type WordEdit =
  | {
      readonly _tag: "cut";
      readonly ops: ReadonlyArray<EditOp>;
      readonly cut: WordCut;
    }
  | {
      readonly _tag: "restore";
      readonly ops: ReadonlyArray<EditOp>;
      readonly restore: WordRestore;
    }
  | { readonly _tag: "nothing" };

/**
 * A text edit as ops on `document`: cutting removes the selected words that play, restoring brings
 * back the selected words that were cut. `nothing` when there is nothing to change.
 */
export function wordEditOps(
  document: EditDocument,
  mediaId: string,
  words: ReadonlyArray<WordSpan>,
  selection: { readonly first: number; readonly last: number },
  action: "cut" | "restore",
): WordEdit {
  const input: WordEditInput = {
    words,
    first: Math.min(selection.first, selection.last),
    last: Math.max(selection.first, selection.last),
    kept: keptSpansOf(document, mediaId),
    mediaFrames: mediaFramesOf(document, mediaId),
    fps: document.fps,
  };
  if (action === "cut") {
    const cut = planWordCut(input);
    const ops = cut === null ? [] : wordCutOps(document, mediaId, cut.range);
    return cut === null || ops.length === 0 ? { _tag: "nothing" } : { _tag: "cut", ops, cut };
  }
  const restore = planWordRestore(input);
  const ops = wordRestoreOps(document, mediaId, restore.ranges);
  return ops.length === 0 ? { _tag: "nothing" } : { _tag: "restore", ops, restore };
}
