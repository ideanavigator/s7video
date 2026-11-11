// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Where a sound effect or music goes in the edit, and the music's duck (S7V-036). Pure: ops from
 * the document. Positions are whole frames at the edit's rate; everything stops where the video
 * ends, since that is what the export renders.
 */
import type {
  EditDocument,
  EditDuck,
  EditFrameRange,
  EditOp,
  EditRational,
  EditTrack,
} from "@t3tools/contracts";

const MUSIC_FADE_IN_MS = 500;
const MUSIC_FADE_OUT_MS = 1000;
const DUCK_ATTACK_MS = 150;
const DUCK_RELEASE_MS = 400;

/** `ms` as whole frames at `fps`, half up, exactly (as the engine rounds). */
export const framesForMs = (ms: number, fps: EditRational) =>
  Math.floor((2 * ms * fps.num + 1000 * fps.den) / (2000 * fps.den));

/** One past the video track's last frame: the length the export renders. */
export const videoEndFrame = (document: EditDocument) =>
  (document.tracks.find((track) => track.kind === "video")?.items ?? []).reduce(
    (end, item) => Math.max(end, item.start + item.duration),
    0,
  );

/** The first id `<prefix>1`, `<prefix>2`… not taken; ids share one space across the edit. */
const freeId = (document: EditDocument, prefix: string) => {
  const taken = new Set<string>([
    ...document.media.map((media) => media.id),
    ...document.markers.map((marker) => marker.id),
    ...document.tracks.flatMap((track) => [track.id, ...track.items.map((item) => item.id)]),
  ]);
  for (let index = 1; ; index++) {
    if (!taken.has(`${prefix}${index}`)) return `${prefix}${index}`;
  }
};

const isFree = (track: EditTrack, start: number, end: number) =>
  track.items.every((item) => item.start >= end || item.start + item.duration <= start);

export interface PlacementRequest {
  readonly media: string;
  readonly track: "sfx" | "music";
  readonly start: number;
  /** The file's length in edit frames. */
  readonly mediaFrames: number;
  readonly gainDb: number;
}

export interface Placement {
  readonly ops: EditOp[];
  readonly item: {
    readonly id: string;
    readonly trackId: string;
    readonly start: number;
    readonly duration: number;
    readonly gainDb: number;
  };
}

/**
 * The item on the first free, unlocked and unmuted track of its kind, or on a new one: a sound
 * that would overlap another goes on a second sound effects track. Sound effects play their full
 * length. Music runs to the video's end with no loop and fades in over 0.5 s and out over 1 s;
 * a bed too short for both fades shares its length between them.
 */
export function placementOps(document: EditDocument, request: PlacementRequest): Placement {
  const duration = Math.min(request.mediaFrames, videoEndFrame(document) - request.start);
  const end = request.start + duration;
  const existing = document.tracks.find(
    (track) =>
      track.kind === request.track &&
      track.locked !== true &&
      track.muted !== true &&
      isFree(track, request.start, end),
  );
  const ops: EditOp[] = [];
  let trackId = existing?.id;
  if (trackId === undefined) {
    trackId = freeId(document, request.track === "sfx" ? "S" : "M");
    ops.push({ _tag: "addTrack", track: { kind: request.track, id: trackId, items: [] } });
  }
  const id = freeId(document, request.track === "sfx" ? "sfx" : "music");
  let fades = {};
  if (request.track === "music") {
    const fadeIn = framesForMs(MUSIC_FADE_IN_MS, document.fps);
    const fadeOut = framesForMs(MUSIC_FADE_OUT_MS, document.fps);
    const share = Math.min(1, duration / (fadeIn + fadeOut));
    fades = {
      fadeInFrames: Math.floor(fadeIn * share),
      fadeOutFrames: Math.floor(fadeOut * share),
    };
  }
  ops.push({
    _tag: "insertItem",
    trackId,
    item: {
      id,
      media: request.media,
      start: request.start,
      duration,
      in: 0,
      gainDb: request.gainDb,
      ...fades,
    },
  });
  return {
    ops,
    item: { id, trackId, start: request.start, duration, gainDb: request.gainDb },
  };
}

/** The fixed duck curve over `ranges`, attack and release in whole frames. */
export const duckOver = (
  document: EditDocument,
  ranges: ReadonlyArray<EditFrameRange>,
  depthDb: number,
): EditDuck => ({
  depthDb,
  attackFrames: framesForMs(DUCK_ATTACK_MS, document.fps),
  releaseFrames: framesForMs(DUCK_RELEASE_MS, document.fps),
  ranges,
});

const sameDuck = (left: EditDuck | undefined, right: EditDuck) =>
  left !== undefined &&
  left.depthDb === right.depthDb &&
  left.attackFrames === right.attackFrames &&
  left.releaseFrames === right.releaseFrames &&
  left.ranges.length === right.ranges.length &&
  left.ranges.every(
    (range, index) =>
      range.start === right.ranges[index]!.start && range.end === right.ranges[index]!.end,
  );

/** `duck` on every music track; none when every one already has it. */
export function duckOps(document: EditDocument, duck: EditDuck): EditOp[] {
  return document.tracks
    .filter((track) => track.kind === "music" && !sameDuck(track.duck, duck))
    .map((track) => ({ _tag: "setTrackProps", trackId: track.id, props: { duck } }));
}
