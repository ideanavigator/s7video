// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Transcript tab's model (S7V-030): the transcript's words at the player's frame rate, each
 * marked kept or removed by the edit, grouped into rows at long pauses, with O(log n) lookups for
 * the word on screen. Pure: no React, no DOM.
 */
import type { EditRational, Transcript } from "@t3tools/contracts";

import {
  nextTimelineSegmentFrom,
  type PlaybackSegment,
  segmentIndexAt,
  sourceFrameOf,
  timelineFrameOf,
  timelineSegmentAt,
  type TimelinePlan,
} from "./editPlayback";

/** A pause longer than this starts a new paragraph (PO default, S7V-030 open question). */
export const PARAGRAPH_PAUSE_SECONDS = 1.5;
/**
 * The most words in one row. A long stretch without a pause still splits, so the list stays
 * virtualised; a split row continues its paragraph with no gap.
 */
export const MAX_ROW_WORDS = 60;

export interface TranscriptModelWord {
  readonly text: string;
  /** Source frames `[start, end)` at the player's frame rate. */
  readonly start: number;
  readonly end: number;
  /** Every frame of the word was cut. */
  readonly removed: boolean;
}

/** One rendered row: words `[first, end)`. */
export interface TranscriptRow {
  readonly key: string;
  readonly first: number;
  readonly end: number;
  /** The row begins a paragraph (after a long pause), rather than continuing one. */
  readonly paragraphStart: boolean;
}

export interface TranscriptModel {
  readonly words: ReadonlyArray<TranscriptModelWord>;
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly removedCount: number;
}

/** What the player plays: its frame rate, and its kept ranges (`null` when nothing is cut). */
export interface TranscriptPlayback {
  readonly fps: EditRational;
  readonly segments: ReadonlyArray<PlaybackSegment> | null;
}

const sameRate = (left: EditRational, right: EditRational) =>
  left.num * right.den === right.num * left.den;

/**
 * True when both play the same frames at the same rate. The panel rebuilds its plan whenever the
 * edit or the media library changes, so the tab keeps its model unless this changes.
 */
export function samePlayback(
  left: TranscriptPlayback | null,
  right: TranscriptPlayback | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.fps.num !== right.fps.num || left.fps.den !== right.fps.den) return false;
  const [a, b] = [left.segments, right.segments];
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every(
    (segment, index) =>
      segment.sourceStart === b[index]!.sourceStart &&
      segment.sourceEnd === b[index]!.sourceEnd &&
      segment.timelineStart === b[index]!.timelineStart,
  );
}

/** A frame at `from` as a frame at `to`; `ceil` for exclusive ends, so a word never shrinks to 0. */
function convertFrame(frame: number, from: EditRational, to: EditRational, ceil: boolean): number {
  if (sameRate(from, to)) return frame;
  const exact = (frame * from.den * to.num) / (from.num * to.den);
  // Float noise on an exact boundary must not move the frame.
  const nearest = Math.round(exact);
  if (Math.abs(exact - nearest) < 1e-9) return nearest;
  return ceil ? Math.ceil(exact) : Math.floor(exact);
}

/** The first segment that ends after `frame`, or `segments.length`. */
function firstSegmentEndingAfter(segments: ReadonlyArray<PlaybackSegment>, frame: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (segments[middle]!.sourceEnd <= frame) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** True when some kept frame lies in `[start, end)`: a word partly kept still counts as kept. */
function isKept(segments: ReadonlyArray<PlaybackSegment>, start: number, end: number): boolean {
  const segment = segments[firstSegmentEndingAfter(segments, start)];
  return segment !== undefined && segment.sourceStart < Math.max(end, start + 1);
}

function splitRows(
  words: ReadonlyArray<TranscriptModelWord>,
  pauseFrames: number,
): ReadonlyArray<TranscriptRow> {
  const rows: TranscriptRow[] = [];
  let first = 0;
  let paragraphStart = true;
  const close = (end: number, nextStartsParagraph: boolean) => {
    if (end > first) rows.push({ key: `w${first}`, first, end, paragraphStart });
    first = end;
    paragraphStart = nextStartsParagraph;
  };
  for (let index = 1; index <= words.length; index += 1) {
    const word = words[index];
    if (word === undefined) break;
    const previous = words[index - 1]!;
    if (word.start - previous.end > pauseFrames) close(index, true);
    else if (index - first >= MAX_ROW_WORDS) close(index, false);
  }
  close(words.length, true);
  return rows;
}

/**
 * Builds the tab's model. Word frames move to the player's rate; `playback.segments` marks each
 * word removed when none of its frames is kept (an empty list removes every word).
 */
export function buildTranscriptModel(
  transcript: Transcript,
  playback: TranscriptPlayback | null,
): TranscriptModel {
  const fps = playback?.fps ?? transcript.fps;
  const segments = playback?.segments ?? null;
  const ordered = [...transcript.words].sort((left, right) => left.startFrame - right.startFrame);
  let removedCount = 0;
  const words = ordered.map((word): TranscriptModelWord => {
    const start = convertFrame(word.startFrame, transcript.fps, fps, false);
    const end = Math.max(start + 1, convertFrame(word.endFrame, transcript.fps, fps, true));
    const removed = segments !== null && !isKept(segments, start, end);
    if (removed) removedCount += 1;
    return { text: word.text, start, end, removed };
  });
  const pauseFrames = (PARAGRAPH_PAUSE_SECONDS * fps.num) / fps.den;
  return { words, rows: splitRows(words, pauseFrames), removedCount };
}

/** The word whose frames hold source frame `frame`, or -1 in a pause. Binary search. */
export function wordAtSourceFrame(model: TranscriptModel, frame: number): number {
  const { words } = model;
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle]!.start <= frame) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found === -1) return -1;
  const word = words[found]!;
  return frame < word.end && !word.removed ? found : -1;
}

/** The word to highlight at edit frame `timelineFrame`, or -1. Never a removed word. */
export function wordAtTimelineFrame(
  model: TranscriptModel,
  segments: ReadonlyArray<PlaybackSegment>,
  timelineFrame: number,
): number {
  if (segments.length === 0) return -1;
  const source = sourceFrameOf(segments, timelineFrame);
  return segmentIndexAt(segments, source) === -1 ? -1 : wordAtSourceFrame(model, source);
}

/**
 * The edit frame a click on word `index` seeks to: its first kept frame, or for a removed word the
 * next kept frame after it. `null` when nothing plays.
 */
export function seekFrameOfWord(
  model: TranscriptModel,
  segments: ReadonlyArray<PlaybackSegment>,
  index: number,
): number | null {
  const word = model.words[index];
  const last = segments.at(-1);
  if (word === undefined || last === undefined) return null;
  const duration = last.timelineStart + last.sourceEnd - last.sourceStart;
  return Math.min(timelineFrameOf(segments, word.start), duration - 1);
}

/** The row holding word `index`. Binary search. */
export function rowOfWord(model: TranscriptModel, index: number): number {
  const { rows } = model;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (rows[middle]!.first <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The clip whose words the Transcript tab shows at edit frame `frame` of a multi-clip edit
 * (S7V-039): the one on screen, or in a gap the next one (the last one after the end).
 */
export function timelineTranscriptSegment(plan: TimelinePlan, frame: number): number {
  const at = timelineSegmentAt(plan.segments, frame);
  if (at !== -1) return at;
  const next = nextTimelineSegmentFrom(plan.segments, frame);
  return next === -1 ? plan.segments.length - 1 : next;
}

/**
 * The Transcript tab's source for segment `index` of a multi-clip edit: that clip's words, kept
 * where the edit plays them, mapped through each item's `in` and `start`. Every item of the clip
 * counts when the edit uses it in source order; otherwise (a clip reused out of order) only the
 * item on screen does, so each word maps to one edit frame.
 */
export function timelineTranscriptPlayback(
  plan: TimelinePlan,
  index: number,
): { readonly mediaId: string; readonly playback: TranscriptPlayback } {
  const current = plan.segments[index]!;
  const own = plan.segments.filter((segment) => segment.mediaId === current.mediaId);
  const inOrder = own.every(
    (segment, at) =>
      at === 0 || segment.in >= own[at - 1]!.in + own[at - 1]!.end - own[at - 1]!.start,
  );
  const used = inOrder ? own : [current];
  return {
    mediaId: current.mediaId,
    playback: {
      fps: plan.fps,
      segments: used.map((segment) => ({
        sourceStart: segment.in,
        sourceEnd: segment.in + segment.end - segment.start,
        timelineStart: segment.start,
      })),
    },
  };
}
