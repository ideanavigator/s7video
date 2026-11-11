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
