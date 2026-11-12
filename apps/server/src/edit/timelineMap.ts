// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Clip frames on the timeline (S7V-036), through the runs and rate rounding the captions use
 * (`@t3tools/shared/captionWords`, the twin of the engine's `map_words`). So a sound placed on a
 * word, that word's caption and the music's duck all land on the same frames.
 */
import type { EditDocument, EditFrameRange, EditRational } from "@t3tools/contracts";
import {
  type CaptionTranscript,
  captionRuns,
  mapCaptionWords,
  toRate,
} from "@t3tools/shared/captionWords";

/**
 * The timeline frame where frame `frame` of `media` (at the clip's `rate`) plays, or null when the
 * edit cut it. A clip placed more than once plays the frame first where it first plays.
 */
export function timelineFrameOf(
  document: EditDocument,
  media: string,
  frame: number,
  rate: EditRational,
): number | null {
  const at = toRate(frame, rate, document.fps);
  for (const run of captionRuns(document)) {
    if (run.media === media && run.sourceIn <= at && at < run.sourceIn + run.frames) {
      return run.start + at - run.sourceIn;
    }
  }
  return null;
}

/**
 * Clip frames `[from, to)` of `media` (at the clip's `rate`) as the timeline ranges that play them
 * (S7V-037), in timeline order; empty when the edit cut them all. A frame placed more than once
 * counts only where it first plays.
 */
export function timelineRangesOf(
  document: EditDocument,
  media: string,
  from: number,
  to: number,
  rate: EditRational,
): EditFrameRange[] {
  const low = toRate(from, rate, document.fps);
  let unplaced: Array<readonly [number, number]> = [
    [low, Math.max(low + 1, toRate(to, rate, document.fps))],
  ];
  const ranges: EditFrameRange[] = [];
  for (const run of captionRuns(document)) {
    if (run.media !== media) continue;
    const runEnd = run.sourceIn + run.frames;
    const rest: Array<readonly [number, number]> = [];
    for (const [a, b] of unplaced) {
      const start = Math.max(a, run.sourceIn);
      const end = Math.min(b, runEnd);
      if (start >= end) {
        rest.push([a, b]);
        continue;
      }
      ranges.push({ start: run.start + start - run.sourceIn, end: run.start + end - run.sourceIn });
      if (a < start) rest.push([a, start]);
      if (end < b) rest.push([end, b]);
    }
    unplaced = rest;
  }
  return ranges.sort((left, right) => left.start - right.start);
}

/** `mm:ss.cc` on the timeline, as a reply names a place: 00:04.20. */
export const timecode = (frames: number, fps: EditRational) => {
  const centis = Math.round((frames * fps.den * 100) / fps.num);
  const minutes = Math.floor(centis / 6000);
  const rest = (centis - minutes * 6000) / 100;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
};

/**
 * Timeline frame `frame` of `media` snapped to the start of the word playing there, or else of
 * the next word heard (PO 2026-11-12), or null after the last word. Word starts are the caption's,
 * so a word that crosses a cut starts where its kept part starts.
 */
export function snapToWord(
  document: EditDocument,
  media: string,
  transcript: CaptionTranscript,
  frame: number,
): { readonly frame: number; readonly word: string } | null {
  const words = mapCaptionWords(document, new Map([[media, transcript]]))
    .flat()
    .sort((left, right) => left.start - right.start);
  const word =
    words.find((entry) => entry.start <= frame && frame < entry.end) ??
    words.find((entry) => entry.start > frame);
  return word === undefined ? null : { frame: word.start, word: word.text };
}

/** `frames / fps < 0.3 s`, exactly; an overlap (negative gap) counts as short. */
const underThreeTenths = (frames: number, fps: EditRational) => frames * fps.den * 10 < 3 * fps.num;

/** The clips' kept words as timeline ranges (end exclusive), merged across gaps under 300 ms. */
export function speechRanges(
  document: EditDocument,
  transcripts: ReadonlyMap<string, CaptionTranscript>,
): EditFrameRange[] {
  const words = mapCaptionWords(document, transcripts)
    .flat()
    .sort((left, right) => left.start - right.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const word of words) {
    const last = ranges.at(-1);
    if (last !== undefined && underThreeTenths(word.start - last.end, document.fps)) {
      last.end = Math.max(last.end, word.end);
    } else {
      ranges.push({ start: word.start, end: word.end });
    }
  }
  return ranges;
}
