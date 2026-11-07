// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * What the timeline draws (S7V-033), derived from `edit.json` v1 without changing any position:
 * one row per track, items sorted by `start`, every position an integer frame at `fps`.
 * Each kind always has a row, so a new edit shows all five; extra tracks of a kind get their own row.
 */
import type { EditDocument, EditRational, EditTrack, EditTrackKind } from "@t3tools/contracts";

/** Top to bottom, as in CapCut: overlays above the video, captions below it, then sound. */
const TRACK_ORDER: ReadonlyArray<EditTrackKind> = ["overlay", "video", "caption", "sfx", "music"];

const TRACK_KIND_LABEL: Record<EditTrackKind, string> = {
  overlay: "Overlays",
  video: "Video",
  caption: "Captions",
  sfx: "Sound effects",
  music: "Music",
};

export interface TimelineItem {
  readonly id: string;
  readonly start: number;
  readonly duration: number;
  readonly label: string;
  /** The project media the item shows, for peaks and filmstrips (S7V-035); none for text. */
  readonly mediaId: string | null;
  /** The source frame at the item's first frame. */
  readonly in: number;
  /** Items sharing a link id move, trim, split and delete together (S7V-034). */
  readonly linkId: string | null;
  /** The media's length in frames, when probed: a trim never reads past it. */
  readonly mediaFrames: number | null;
}

export interface TimelineRow {
  /** The track's id, or `kind:<kind>` for a kind the edit has no track of yet. */
  readonly id: string;
  readonly kind: EditTrackKind;
  readonly label: string;
  readonly items: ReadonlyArray<TimelineItem>;
  readonly muted: boolean;
  readonly locked: boolean;
  /** False for a kind the edit has no track of yet: nothing can be placed on it by hand. */
  readonly real: boolean;
}

export interface TimelineModel {
  readonly fps: EditRational;
  readonly rows: ReadonlyArray<TimelineRow>;
  /** One past the last item's last frame; 0 for an edit with no items. */
  readonly durationFrames: number;
  readonly itemCount: number;
}

function itemsOf(
  track: EditTrack,
  mediaLabels: ReadonlyMap<string, string>,
  mediaFrames: ReadonlyMap<string, number>,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const item of track.items) {
    const mediaId = "media" in item && item.media !== undefined ? item.media : null;
    const text = "text" in item && typeof item.text === "string" ? item.text : undefined;
    const label =
      ("label" in item ? item.label : undefined) ??
      text ??
      (mediaId === null ? undefined : mediaLabels.get(mediaId)) ??
      item.id;
    items.push({
      id: item.id,
      start: item.start,
      duration: item.duration,
      label,
      mediaId,
      in: "in" in item && item.in !== undefined ? item.in : 0,
      linkId: "linkId" in item && item.linkId !== undefined ? item.linkId : null,
      mediaFrames: mediaId === null ? null : (mediaFrames.get(mediaId) ?? null),
    });
  }
  return items.sort((left, right) => left.start - right.start);
}

export function timelineModelOf(document: EditDocument): TimelineModel {
  const mediaLabels = new Map<string, string>();
  const mediaFrames = new Map<string, number>();
  for (const media of document.media) {
    const name = media.label ?? (media.path ?? media.reference ?? media.id).split("/").at(-1);
    mediaLabels.set(media.id, name ?? media.id);
    const frames = media.probe.durationFrames;
    if (frames !== undefined) mediaFrames.set(media.id, frames);
  }
  const rows: TimelineRow[] = [];
  let durationFrames = 0;
  let itemCount = 0;
  for (const kind of TRACK_ORDER) {
    const tracks = document.tracks.filter((track) => track.kind === kind);
    if (tracks.length === 0) {
      rows.push({
        id: `kind:${kind}`,
        kind,
        label: TRACK_KIND_LABEL[kind],
        items: [],
        muted: false,
        locked: false,
        real: false,
      });
      continue;
    }
    tracks.forEach((track, index) => {
      const items = itemsOf(track, mediaLabels, mediaFrames);
      for (const item of items)
        durationFrames = Math.max(durationFrames, item.start + item.duration);
      itemCount += items.length;
      rows.push({
        id: track.id,
        kind,
        label:
          track.label ??
          (tracks.length > 1 ? `${TRACK_KIND_LABEL[kind]} ${index + 1}` : TRACK_KIND_LABEL[kind]),
        items,
        muted: track.muted ?? false,
        locked: track.locked ?? false,
        real: true,
      });
    });
  }
  return { fps: document.fps, rows, durationFrames, itemCount };
}

/** The first item that ends after `frame`; items on a row are sorted and do not overlap. */
export function firstItemEndingAfter(items: ReadonlyArray<TimelineItem>, frame: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const item = items[middle]!;
    if (item.start + item.duration <= frame) low = middle + 1;
    else high = middle;
  }
  return low;
}
