// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Captions in the edit (S7V-075): transcript words mapped onto the timeline, one caption item per
 * uncut run. A port of the engine's `map_words` (`captions_from_words.py`); the parity test keeps
 * them equal, so the track exports the same captions as the transcript fallback.
 */
import type {
  EditCaptionTrack,
  EditDocument,
  EditOp,
  EditRational,
  EditTrack,
} from "@t3tools/contracts";

/** What a caption item needs from a clip's transcript: its rate and its words in clip frames. */
export interface CaptionTranscript {
  readonly fps: EditRational;
  readonly words: ReadonlyArray<{
    readonly text: string;
    readonly startFrame: number;
    /** Exclusive. */
    readonly endFrame: number;
  }>;
}

/** A kept word on the timeline, `end` exclusive. */
export interface TimelineWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The kept words of one uncut run, and the clip they come from. */
interface CaptionGroup {
  readonly media: string;
  readonly words: TimelineWord[];
}

/** A stretch of the timeline that plays `media` from `sourceIn` without a cut. */
interface CaptionRun {
  readonly start: number;
  readonly frames: number;
  readonly media: string;
  readonly sourceIn: number;
}

/** The caption a run gives: the shape `setCaptions` takes, ids allocated by the op. */
export interface CaptionItemDraft {
  readonly start: number;
  readonly duration: number;
  readonly text: string;
  readonly words?: ReadonlyArray<{
    readonly text: string;
    readonly start: number;
    readonly duration: number;
  }>;
  /** `s7.media`: the clip the words come from, so a rebuild can keep a clip it can't read. */
  readonly metadata?: { readonly [key: string]: unknown };
}

const CAPTION_TRACK_LABEL = "Captions";
/** `metadata.s7.source` of a caption track rebuilt from the transcripts after every cut. */
const TRANSCRIPT_CAPTION_SOURCE = "transcript";

/** The first video track: the one the export renders (`plan_segments`). */
const firstVideoTrack = (document: EditDocument) =>
  document.tracks.find((track) => track.kind === "video");

/** The video track's items as runs, joining items that continue their source exactly (a split). */
function captionRuns(document: EditDocument): CaptionRun[] {
  const items = [...(firstVideoTrack(document)?.items ?? [])].sort((a, b) => a.start - b.start);
  const runs: CaptionRun[] = [];
  for (const item of items) {
    if (item.duration <= 0) continue;
    const last = runs.at(-1);
    if (
      last !== undefined &&
      last.media === item.media &&
      last.start + last.frames === item.start &&
      last.sourceIn + last.frames === item.in
    ) {
      runs[runs.length - 1] = { ...last, frames: last.frames + item.duration };
    } else {
      runs.push({ start: item.start, frames: item.duration, media: item.media, sourceIn: item.in });
    }
  }
  return runs;
}

/** `floor(frame * to / from + 1/2)`, exactly: the engine's `_to_rate`. */
function toRate(frame: number, from: EditRational, to: EditRational): number {
  const a = BigInt(to.num) * BigInt(from.den);
  const b = BigInt(to.den) * BigInt(from.num);
  const twice = 2n * BigInt(frame) * a + b;
  const divisor = 2n * b;
  // Frames are never negative, so BigInt's truncating division is the floor.
  return Number(twice / divisor);
}

/** The kept words on the timeline, one list per uncut run that has any, in timeline order. */
export function mapCaptionWords(
  document: EditDocument,
  transcripts: ReadonlyMap<string, CaptionTranscript>,
): TimelineWord[][] {
  return captionGroups(document, transcripts).map((group) => group.words);
}

function captionGroups(
  document: EditDocument,
  transcripts: ReadonlyMap<string, CaptionTranscript>,
): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  for (const run of captionRuns(document)) {
    const transcript = transcripts.get(run.media);
    if (transcript === undefined) continue;
    const low = run.sourceIn;
    const high = run.sourceIn + run.frames;
    const shift = run.start - low;
    const words: TimelineWord[] = [];
    for (const word of transcript.words) {
      // Python's `str.strip()`; the export joins and splits words on whitespace either way.
      const text = word.text.trim();
      const start = Math.max(toRate(word.startFrame, transcript.fps, document.fps), low);
      const end = Math.min(toRate(word.endFrame, transcript.fps, document.fps), high);
      if (text !== "" && end > start) words.push({ text, start: start + shift, end: end + shift });
    }
    words.sort((left, right) => left.start - right.start);
    if (words.length > 0) groups.push({ media: run.media, words });
  }
  return groups;
}

/** One caption item per uncut run, its words in timeline frames. */
export function captionItemsFor(
  document: EditDocument,
  transcripts: ReadonlyMap<string, CaptionTranscript>,
): CaptionItemDraft[] {
  return captionGroups(document, transcripts).map(({ media, words }) => {
    const start = words[0]!.start;
    const end = Math.max(...words.map((word) => word.end));
    return {
      start,
      duration: end - start,
      text: words.map((word) => word.text).join(" "),
      words: words.map((word) => ({
        text: word.text,
        start: word.start,
        duration: word.end - word.start,
      })),
      metadata: { s7: { media } },
    };
  });
}

/** The clip a caption item was made from, as `captionItemsFor` records it. */
export function captionMediaOfItem(item: { readonly metadata?: unknown }): string | undefined {
  const s7 = (item.metadata as { readonly s7?: { readonly media?: unknown } } | undefined)?.s7;
  return typeof s7?.media === "string" ? s7.media : undefined;
}

/**
 * The media whose transcripts caption the edit: those on the first video track that have sound.
 * A clip without audio cannot be transcribed, so it gets no captions (as the export).
 */
export function captionMediaOf(document: EditDocument): string[] {
  const audible = new Set(
    document.media.filter((entry) => entry.probe.hasAudio).map((entry) => entry.id),
  );
  const items = firstVideoTrack(document)?.items ?? [];
  return [...new Set(items.map((item) => item.media))].filter((media) => audible.has(media));
}

/** True for a caption track made by "add captions", which is rebuilt after every cut. */
function isTranscriptCaptionTrack(track: EditTrack): track is EditCaptionTrack {
  if (track.kind !== "caption") return false;
  const s7 = track.metadata?.["s7"];
  return (
    typeof s7 === "object" &&
    s7 !== null &&
    (s7 as Record<string, unknown>)["source"] === TRANSCRIPT_CAPTION_SOURCE
  );
}

export const transcriptCaptionTrackOf = (document: EditDocument): EditCaptionTrack | undefined =>
  document.tracks.find(isTranscriptCaptionTrack);

/** The first free track id `C1`, `C2`…; ids share one space across the edit. */
function freeTrackId(document: EditDocument): string {
  const taken = new Set<string>([
    ...document.media.map((media) => media.id),
    ...document.markers.map((marker) => marker.id),
    ...document.tracks.flatMap((track) => [track.id, ...track.items.map((item) => item.id)]),
  ]);
  for (let index = 1; ; index++) {
    if (!taken.has(`C${index}`)) return `C${index}`;
  }
}

/**
 * The ops that make the edit's transcript caption track match `transcripts`: a `setCaptions` on
 * the track, after an `addTrack` when the edit has none. Never a second track.
 */
export function captionTrackOps(
  document: EditDocument,
  transcripts: ReadonlyMap<string, CaptionTranscript>,
): EditOp[] {
  const captions = captionItemsFor(document, transcripts);
  const existing = transcriptCaptionTrackOf(document);
  if (existing !== undefined) {
    return [{ _tag: "setCaptions", trackId: existing.id, captions }];
  }
  const trackId = freeTrackId(document);
  return [
    {
      _tag: "addTrack",
      track: {
        kind: "caption",
        id: trackId,
        label: CAPTION_TRACK_LABEL,
        metadata: { s7: { source: TRANSCRIPT_CAPTION_SOURCE } },
        items: [],
      },
    },
    { _tag: "setCaptions", trackId, captions },
  ];
}

/** True when the captions of `track` already equal `captions` (ids aside). */
export function sameCaptions(
  track: EditCaptionTrack,
  captions: ReadonlyArray<CaptionItemDraft>,
): boolean {
  if (track.items.length !== captions.length) return false;
  return track.items.every((item, index) => {
    const want = captions[index]!;
    return (
      item.start === want.start &&
      item.duration === want.duration &&
      item.text === want.text &&
      item.style === undefined &&
      JSON.stringify(item.metadata) === JSON.stringify(want.metadata) &&
      JSON.stringify(item.words) === JSON.stringify(want.words)
    );
  });
}
