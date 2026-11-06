// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  type EditDocument,
  type EditItemProps,
  type EditOp,
  EditOpError,
  type EditSourceRange,
  type EditTrackKind,
  type EditTrackProps,
} from "@t3tools/contracts";

/** A working copy: ops edit plain records, and validation checks the result afterwards. */
interface DraftItem {
  id: string;
  start: number;
  duration: number;
  in?: number;
  media?: string;
  [key: string]: unknown;
}
interface DraftTrack {
  id: string;
  kind: EditTrackKind;
  items: DraftItem[];
  [key: string]: unknown;
}
interface DraftDocument {
  tracks: DraftTrack[];
  media: Array<EditDocument["media"][number]>;
  markers: Array<EditDocument["markers"][number]>;
  [key: string]: unknown;
}

const ITEM_PREFIX: Record<EditTrackKind, string> = {
  video: "v",
  caption: "c",
  sfx: "s",
  music: "m",
  overlay: "o",
};

class OpFailure extends Error {
  readonly itemId: string | null;
  readonly explanation: string;
  constructor(itemId: string | null, explanation: string) {
    super(explanation);
    this.itemId = itemId;
    this.explanation = explanation;
  }
}

const fail = (itemId: string | null, explanation: string): never => {
  throw new OpFailure(itemId, explanation);
};

// Code-point order for ties, as the engine sorts, so both write and report the same thing.
const byStart = (a: DraftItem, b: DraftItem) =>
  a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The source frame an item starts at; a media overlay without `in` starts at 0. */
const sourceIn = (item: DraftItem) =>
  typeof item.in === "number" ? item.in : item.media !== undefined ? 0 : undefined;

/** Every id in the document: media, markers, tracks and items share one namespace. */
export function allIds(
  document: Pick<EditDocument, "media" | "markers" | "tracks"> | DraftDocument,
): Set<string> {
  const ids = new Set<string>();
  for (const media of document.media) ids.add(media.id);
  for (const marker of document.markers) ids.add(marker.id);
  for (const track of document.tracks) {
    ids.add(track.id);
    for (const item of track.items) ids.add(item.id);
  }
  return ids;
}

function allocateId(document: DraftDocument, prefix: string, taken = allIds(document)): string {
  for (let index = 1; ; index++) {
    const candidate = `${prefix}${index}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function findTrack(document: DraftDocument, trackId: string): DraftTrack {
  return (
    document.tracks.find((track) => track.id === trackId) ??
    fail(trackId, `There is no track "${trackId}" in this edit.`)
  );
}

function findItem(document: DraftDocument, itemId: string) {
  for (const track of document.tracks) {
    const index = track.items.findIndex((item) => item.id === itemId);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  return fail(itemId, `There is no item "${itemId}" in this edit.`);
}

function requireKind(track: DraftTrack, kinds: ReadonlyArray<EditTrackKind>, what: string) {
  if (!kinds.includes(track.kind)) {
    fail(
      track.id,
      `Track "${track.id}" is a ${track.kind} track; ${what} needs a ${kinds.join(" or ")} track.`,
    );
  }
}

/** Applies `null` as "remove" and any other value as "set". */
function assignProps(target: Record<string, unknown>, props: Record<string, unknown>) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (value === null) delete target[key];
    else target[key] = value;
  }
}

/** Lays source ranges end to end from `start`, keeping the ids and props of items that match. */
function layRanges(
  document: DraftDocument,
  track: DraftTrack,
  mediaId: string,
  ranges: ReadonlyArray<EditSourceRange>,
  start: number,
): DraftItem[] {
  const previous = track.items.filter((item) => "media" in item && item.media === mediaId);
  const used = new Set<DraftItem>();
  const matches = ranges.map((range) => {
    const match = previous.find(
      (item) =>
        !used.has(item) && "in" in item && item.in === range.in && item.duration === range.duration,
    );
    if (match !== undefined) used.add(match);
    return match;
  });
  // Freed ids are reused, but never one a matched range keeps (S7V-058).
  const taken = allIds(document);
  for (const item of previous) taken.delete(item.id);
  for (const match of matches) if (match !== undefined) taken.add(match.id);
  let at = start;
  return ranges.map((range, index) => {
    const match = matches[index];
    const id = match?.id ?? allocateId(document, ITEM_PREFIX.video, taken);
    const item = {
      ...match,
      id,
      media: mediaId,
      start: at,
      duration: range.duration,
      in: range.in,
    };
    at += range.duration;
    return item as DraftItem;
  });
}

function mergeRanges(ranges: ReadonlyArray<EditSourceRange>): EditSourceRange[] {
  const sorted = [...ranges].sort((a, b) => a.in - b.in);
  const merged: EditSourceRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.in <= last.in + last.duration) {
      const end = Math.max(last.in + last.duration, range.in + range.duration);
      merged[merged.length - 1] = { in: last.in, duration: end - last.in };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function shiftAfter(track: DraftTrack, from: number, by: number, except?: string) {
  for (const item of track.items) {
    if (item.id !== except && item.start >= from) item.start += by;
  }
}

function applyOne(document: DraftDocument, op: EditOp): void {
  switch (op._tag) {
    case "setKeepRanges": {
      const track = findTrack(document, op.trackId);
      requireKind(track, ["video"], "keeping ranges");
      const others = track.items.filter((item) => !("media" in item) || item.media !== op.mediaId);
      track.items = [
        ...others,
        ...layRanges(document, track, op.mediaId, op.ranges, op.start ?? 0),
      ];
      return;
    }
    case "restoreRange": {
      const track = findTrack(document, op.trackId);
      requireKind(track, ["video"], "restoring a range");
      const kept = track.items
        .filter((item) => "media" in item && item.media === op.mediaId)
        .sort(byStart);
      const start = kept[0]?.start ?? 0;
      const ranges = mergeRanges([
        ...kept.map((item) => ({ in: (item as { in: number }).in, duration: item.duration })),
        op.range,
      ]);
      const others = track.items.filter((item) => !("media" in item) || item.media !== op.mediaId);
      track.items = [...others, ...layRanges(document, track, op.mediaId, ranges, start)];
      return;
    }
    case "setCaptions": {
      const track = findTrack(document, op.trackId);
      requireKind(track, ["caption"], "captions");
      const taken = allIds(document);
      for (const item of track.items) taken.delete(item.id);
      track.items = op.captions.map((caption) => {
        const id = caption.id ?? allocateId(document, ITEM_PREFIX.caption, taken);
        taken.add(id);
        return { ...caption, id } as DraftItem;
      });
      return;
    }
    case "insertItem": {
      const track = findTrack(document, op.trackId);
      const id = op.item.id ?? allocateId(document, ITEM_PREFIX[track.kind]);
      if (op.ripple === true) shiftAfter(track, op.item.start, op.item.duration);
      track.items.push({ ...op.item, id } as DraftItem);
      return;
    }
    case "moveItem": {
      const found = findItem(document, op.itemId);
      const target = op.toTrackId === undefined ? found.track : findTrack(document, op.toTrackId);
      if (target.kind !== found.track.kind) {
        fail(op.itemId, `"${op.itemId}" can only move to another ${found.track.kind} track.`);
      }
      found.track.items.splice(found.index, 1);
      target.items.push({ ...found.item, start: op.start });
      return;
    }
    case "trimItem": {
      const { item } = findItem(document, op.itemId);
      const end = item.start + item.duration;
      if (op.edge === "start") {
        if (op.frame >= end) fail(op.itemId, `"${op.itemId}" would have no frames left.`);
        const delta = op.frame - item.start;
        const from = sourceIn(item);
        if (from !== undefined) {
          if (from + delta < 0) fail(op.itemId, `"${op.itemId}" cannot start before its media.`);
          item.in = from + delta;
        }
        item.start = op.frame;
        item.duration = end - op.frame;
      } else {
        if (op.frame <= item.start) fail(op.itemId, `"${op.itemId}" would have no frames left.`);
        item.duration = op.frame - item.start;
      }
      return;
    }
    case "splitItem": {
      const { track, item } = findItem(document, op.itemId);
      const end = item.start + item.duration;
      if (op.atFrame <= item.start || op.atFrame >= end) {
        fail(
          op.itemId,
          `Frame ${op.atFrame} is not inside "${op.itemId}" (${item.start} to ${end}).`,
        );
      }
      const id = op.newItemId ?? allocateId(document, ITEM_PREFIX[track.kind]);
      const left = op.atFrame - item.start;
      const right: DraftItem = {
        ...item,
        id,
        start: op.atFrame,
        duration: end - op.atFrame,
      };
      const from = sourceIn(item);
      if (from !== undefined) right.in = from + left;
      if ("fadeInFrames" in item) delete right.fadeInFrames;
      if ("fadeOutFrames" in item) delete item.fadeOutFrames;
      if ("words" in item && Array.isArray(item.words)) {
        const words = item.words as ReadonlyArray<{
          readonly start: number;
          readonly duration: number;
          readonly text: string;
        }>;
        // A word spoken across the cut ends at it, so it stays inside the left half.
        const before = words
          .filter((word) => word.start < op.atFrame)
          .map((word) => ({ ...word, duration: Math.min(word.duration, op.atFrame - word.start) }));
        const after = words.filter((word) => word.start >= op.atFrame);
        // Text follows the words, so a half without words is left with no text, not a copy.
        item.words = before;
        right.words = after;
        item.text = before.map((word) => word.text).join(" ");
        right.text = after.map((word) => word.text).join(" ");
      }
      item.duration = left;
      track.items.push(right);
      return;
    }
    case "deleteItem": {
      for (const itemId of op.itemIds) {
        const { track, index, item } = findItem(document, itemId);
        track.items.splice(index, 1);
        if (op.ripple) shiftAfter(track, item.start + item.duration, -item.duration);
      }
      return;
    }
    case "setItemProps": {
      const { item } = findItem(document, op.itemId);
      assignProps(item, op.props satisfies EditItemProps);
      return;
    }
    case "addTrack": {
      if (allIds(document).has(op.track.id)) fail(op.track.id, `"${op.track.id}" is already used.`);
      const track = structuredClone(op.track) as DraftTrack;
      const index = Math.min(op.index ?? document.tracks.length, document.tracks.length);
      document.tracks.splice(index, 0, track);
      return;
    }
    case "setCaptionStyle": {
      const track = findTrack(document, op.trackId);
      requireKind(track, ["caption"], "a caption style");
      (track as Record<string, unknown>).style = op.style;
      return;
    }
    case "setTrackProps": {
      const track = findTrack(document, op.trackId);
      if (op.props.duck !== undefined && op.props.duck !== null) {
        requireKind(track, ["music"], "ducking");
      }
      assignProps(track as Record<string, unknown>, op.props satisfies EditTrackProps);
      return;
    }
    case "putMedia": {
      const index = document.media.findIndex((media) => media.id === op.media.id);
      if (index === -1) document.media.push(op.media);
      else document.media[index] = op.media;
      return;
    }
    case "removeMedia": {
      const user = document.tracks
        .flatMap((track) => track.items)
        .find((item) => "media" in item && item.media === op.mediaId);
      if (user !== undefined) {
        fail(op.mediaId, `Media "${op.mediaId}" is still used by "${user.id}".`);
      }
      document.media = document.media.filter((media) => media.id !== op.mediaId);
      return;
    }
    case "setMarkers": {
      document.markers = [...op.markers];
      return;
    }
  }
}

/**
 * Applies ops in order to a copy of the document. Items come out sorted by start, so the same ops
 * always write the same bytes. The result still has to pass `validateEditDocument`.
 */
export function applyEditOps(
  document: EditDocument,
  ops: ReadonlyArray<EditOp>,
):
  | { readonly _tag: "applied"; readonly document: EditDocument }
  | {
      readonly _tag: "failed";
      readonly error: EditOpError;
    } {
  const draft = structuredClone(document) as unknown as DraftDocument;
  for (const [opIndex, op] of ops.entries()) {
    try {
      applyOne(draft, op);
    } catch (cause) {
      if (!(cause instanceof OpFailure)) throw cause;
      return {
        _tag: "failed",
        error: new EditOpError({
          opIndex,
          op: op._tag,
          itemId: cause.itemId,
          explanation: cause.explanation,
        }),
      };
    }
  }
  for (const track of draft.tracks) track.items.sort(byStart);
  return { _tag: "applied", document: draft as unknown as EditDocument };
}
