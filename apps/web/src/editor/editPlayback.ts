// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * How the Editor player plays an edit (S7V-029): the kept parts of one source clip, in order, as
 * frame ranges at the document fps. The player plays a range and seeks over the gap to the next.
 * Frames are integers; times are seconds in the source file.
 */
import type { EditCanvas, EditDocument, EditRational } from "@t3tools/contracts";

/** Source frames `[sourceStart, sourceEnd)` that play from `timelineStart` in the edit. */
export interface PlaybackSegment {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly timelineStart: number;
}

export interface PlaybackPlan {
  readonly mediaId: string;
  readonly fps: EditRational;
  readonly segments: ReadonlyArray<PlaybackSegment>;
  /** The edit's length in frames: the sum of the segments. */
  readonly durationFrames: number;
  /** Items on other clips, which this player leaves out until multi-clip playback (S7V-039). */
  readonly otherClipItems: number;
  /** The edit's output frame, which export fills and crops to (S7V-061); none for a raw clip. */
  readonly canvas?: EditCanvas;
}

/**
 * Media timestamps can be rounded to the millisecond (WebM), so a frame can start up to half a
 * millisecond before its exact time. One millisecond of slack keeps it in its own frame.
 */
const TIMESTAMP_SLACK_SECONDS = 0.001;

/** The source frame showing at `seconds`. */
export function frameAtTime(seconds: number, fps: EditRational): number {
  return Math.max(0, Math.floor(((seconds + TIMESTAMP_SLACK_SECONDS) * fps.num) / fps.den));
}

/** The middle of `frame`: seeking there never lands on the frame before (spike A2). */
export function timeOfFrame(frame: number, fps: EditRational): number {
  return ((frame + 0.5) * fps.den) / fps.num;
}

function plan(
  mediaId: string,
  fps: EditRational,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  otherClipItems: number,
): PlaybackPlan {
  const segments: PlaybackSegment[] = [];
  let timeline = 0;
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    const last = segments.at(-1);
    // Back-to-back ranges play straight through; a seek there would only cost a stall.
    if (last !== undefined && last.sourceEnd === range.start) {
      segments[segments.length - 1] = { ...last, sourceEnd: range.end };
    } else {
      segments.push({ sourceStart: range.start, sourceEnd: range.end, timelineStart: timeline });
    }
    timeline += range.end - range.start;
  }
  return { mediaId, fps, segments, durationFrames: timeline, otherClipItems };
}

/**
 * The edit's first video track, played from its first clip. `null` when the edit has no video
 * item yet (an empty project, or media not placed on the timeline).
 */
export function editPlaybackPlan(document: EditDocument): PlaybackPlan | null {
  const track = document.tracks.find((entry) => entry.kind === "video");
  if (track === undefined || track.kind !== "video") return null;
  const items = [...track.items].sort((left, right) => left.start - right.start);
  const mediaId = items[0]?.media;
  if (mediaId === undefined) return null;
  const own = items.filter((item) => item.media === mediaId);
  return {
    ...plan(
      mediaId,
      document.fps,
      own.map((item) => ({ start: item.in, end: item.in + item.duration })),
      items.length - own.length,
    ),
    canvas: document.canvas,
  };
}

/** One clip played whole, for previewing a clip from the Assets tab. */
export function clipPlaybackPlan(
  mediaId: string,
  durationFrames: number,
  fps: EditRational,
): PlaybackPlan {
  return plan(mediaId, fps, [{ start: 0, end: durationFrames }], 0);
}

/** The segment holding source frame `frame`, or -1 when that frame was cut. */
export function segmentIndexAt(segments: ReadonlyArray<PlaybackSegment>, frame: number): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle]!;
    if (frame < segment.sourceStart) high = middle - 1;
    else if (frame >= segment.sourceEnd) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** The first segment that starts after source frame `frame`, or -1 after the last. */
function nextSegmentIndexAfter(segments: ReadonlyArray<PlaybackSegment>, frame: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (segments[middle]!.sourceStart <= frame) low = middle + 1;
    else high = middle;
  }
  return low < segments.length ? low : -1;
}

export type PlaybackStep =
  | { readonly _tag: "play" }
  | { readonly _tag: "skip"; readonly toSegment: number; readonly toFrame: number }
  | { readonly _tag: "end" };

/**
 * What to do after source frame `presented` is on screen. When the next frame would be cut, seek
 * to the next kept frame now, so the cut frame is never shown.
 */
export function stepAfterFrame(
  segments: ReadonlyArray<PlaybackSegment>,
  presented: number,
): PlaybackStep {
  const index = segmentIndexAt(segments, presented);
  if (index !== -1 && presented + 1 < segments[index]!.sourceEnd) return { _tag: "play" };
  const next = index === -1 ? nextSegmentIndexAfter(segments, presented) : index + 1;
  const segment = segments[next];
  if (segment === undefined) return { _tag: "end" };
  return { _tag: "skip", toSegment: next, toFrame: segment.sourceStart };
}

/** The edit frame showing source frame `frame`; a cut frame counts as the next kept one. */
export function timelineFrameOf(segments: ReadonlyArray<PlaybackSegment>, frame: number): number {
  const index = segmentIndexAt(segments, frame);
  if (index !== -1) {
    const segment = segments[index]!;
    return segment.timelineStart + frame - segment.sourceStart;
  }
  const next = segments[nextSegmentIndexAfter(segments, frame)];
  if (next !== undefined) return next.timelineStart;
  const last = segments.at(-1);
  return last === undefined ? 0 : last.timelineStart + last.sourceEnd - last.sourceStart;
}

/** The source frame at edit frame `frame`, clamped to the edit. */
export function sourceFrameOf(segments: ReadonlyArray<PlaybackSegment>, frame: number): number {
  const last = segments.at(-1);
  if (last === undefined) return 0;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (segments[middle]!.timelineStart <= frame) low = middle;
    else high = middle - 1;
  }
  const segment = segments[low]!;
  const offset = Math.max(0, frame - segment.timelineStart);
  return Math.min(segment.sourceStart + offset, segment.sourceEnd - 1);
}

/** `mm:ss` (or `h:mm:ss`) of an edit frame, for the player's clock. */
export function formatPlaybackClock(frame: number, fps: EditRational): string {
  const total = Math.floor((frame * fps.den) / fps.num);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
