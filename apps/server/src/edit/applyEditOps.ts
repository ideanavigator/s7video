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

interface DraftWord {
  readonly text: string;
  readonly start: number;
  readonly duration: number;
}

const wordsOf = (item: DraftItem): ReadonlyArray<DraftWord> | null =>
  "words" in item && Array.isArray(item.words) ? (item.words as ReadonlyArray<DraftWord>) : null;

/** Moves an item along the timeline; caption words hold timeline frames, so they move with it. */
function shiftItem(item: DraftItem, by: number) {
  item.start += by;
  const words = wordsOf(item);
  if (words !== null && by !== 0) {
    item.words = words.map((word) => ({ ...word, start: word.start + by }));
  }
}

/**
 * Keeps a caption's words inside its frames after a trim: words outside are dropped, a word cut
 * by an edge is shortened, and the text follows the words (as a split does).
 */
function clipWords(item: DraftItem) {
  const words = wordsOf(item);
  if (words === null) return;
  const end = item.start + item.duration;
  const kept: DraftWord[] = [];
  for (const word of words) {
    const from = Math.max(word.start, item.start);
    const to = Math.min(word.start + word.duration, end);
    if (to > from) kept.push({ ...word, start: from, duration: to - from });
  }
  const changed =
    kept.length !== words.length ||
    kept.some(
      (word, index) =>
        word.start !== words[index]!.start || word.duration !== words[index]!.duration,
    );
  if (!changed) return;
  item.words = kept;
  item.text = kept.map((word) => word.text).join(" ");
}

function shiftAfter(track: DraftTrack, from: number, by: number, except?: string) {
  for (const item of track.items) {
    if (item.id !== except && item.start >= from) shiftItem(item, by);
  }
}

/**
 * The item and every other item sharing its `linkId` (S7V-034): linked audio and video move,
 * trim, split and delete together, from the timeline and from agent tools alike.
 */
function withLinked(document: DraftDocument, itemId: string) {
  const found = findItem(document, itemId);
  const linkId = typeof found.item.linkId === "string" ? found.item.linkId : undefined;
  const linked: Array<{ track: DraftTrack; item: DraftItem }> = [];
  if (linkId !== undefined) {
    for (const track of document.tracks) {
      for (const item of track.items) {
        if (item !== found.item && item.linkId === linkId) linked.push({ track, item });
      }
    }
  }
  return { ...found, linked };
}

function trimOne(item: DraftItem, edge: "start" | "end", frame: number) {
  const end = item.start + item.duration;
  if (edge === "start") {
    if (frame >= end) fail(item.id, `"${item.id}" would have no frames left.`);
    const delta = frame - item.start;
    const from = sourceIn(item);
    if (from !== undefined) {
      if (from + delta < 0) fail(item.id, `"${item.id}" cannot start before its media.`);
      item.in = from + delta;
    }
    item.start = frame;
    item.duration = end - frame;
  } else {
    if (frame <= item.start) fail(item.id, `"${item.id}" would have no frames left.`);
    item.duration = frame - item.start;
  }
  clipWords(item);
}

/** Splits `item` at `atFrame` and returns the right-hand part, already on `track`. */
function splitOne(track: DraftTrack, item: DraftItem, atFrame: number, id: string): DraftItem {
  const end = item.start + item.duration;
  const left = atFrame - item.start;
  const right: DraftItem = {
    ...item,
    id,
    start: atFrame,
    duration: end - atFrame,
  };
  const from = sourceIn(item);
  if (from !== undefined) right.in = from + left;
  if ("fadeInFrames" in item) delete right.fadeInFrames;
  if ("fadeOutFrames" in item) delete item.fadeOutFrames;
  const words = wordsOf(item);
  if (words !== null) {
    // A word spoken across the cut ends at it, so it stays inside the left half.
    const before = words
      .filter((word) => word.start < atFrame)
      .map((word) => ({ ...word, duration: Math.min(word.duration, atFrame - word.start) }));
    const after = words.filter((word) => word.start >= atFrame);
    // Text follows the words, so a half without words is left with no text, not a copy.
    item.words = before;
    right.words = after;
    item.text = before.map((word) => word.text).join(" ");
    right.text = after.map((word) => word.text).join(" ");
  }
  item.duration = left;
  track.items.push(right);
  return right;
}

const sameLink = (left: DraftItem, right: DraftItem) =>
  (left.linkId ?? null) === (right.linkId ?? null);

/**
 * Puts back the frames of `range` the track does not play, beside the items that play their
 * source neighbours; later items move right, so manual moves stay (S7V-038, PO 2026-11-06).
 * Linked items are not extended: nothing writes `linkId` yet (S7V-036).
 */
function restoreOnTrack(
  document: DraftDocument,
  track: DraftTrack,
  mediaId: string,
  range: EditSourceRange,
) {
  const own = () =>
    track.items
      .filter((item) => item.media === mediaId && typeof item.in === "number")
      .sort(byStart) as Array<DraftItem & { in: number }>;
  const missing: Array<[number, number]> = [];
  let at = range.in;
  const end = range.in + range.duration;
  for (const kept of mergeRanges(own().map((item) => ({ in: item.in, duration: item.duration })))) {
    if (kept.in + kept.duration <= at) continue;
    if (kept.in >= end) break;
    if (kept.in > at) missing.push([at, kept.in]);
    at = Math.max(at, kept.in + kept.duration);
  }
  if (at < end) missing.push([at, end]);

  for (const [from, to] of missing) {
    const length = to - from;
    const items = own();
    const left = items.find((item) => item.in + item.duration === from);
    const right = items.find((item) => item.in === to);
    if (left !== undefined) {
      const join = left.start + left.duration;
      shiftAfter(track, join, length, left.id);
      left.duration += length;
      if (right !== undefined && right.start === join + length && sameLink(left, right)) {
        left.duration += right.duration;
        if ("fadeOutFrames" in right) left.fadeOutFrames = right.fadeOutFrames;
        else delete left.fadeOutFrames;
        track.items.splice(track.items.indexOf(right), 1);
      }
      continue;
    }
    if (right !== undefined) {
      shiftAfter(track, right.start, length, right.id);
      right.in = from;
      right.duration += length;
      continue;
    }
    const before = items
      .filter((item) => item.in + item.duration < from)
      .sort((a, b) => b.in + b.duration - (a.in + a.duration))[0];
    const after = items.filter((item) => item.in > to).sort((a, b) => a.in - b.in)[0];
    const place = before !== undefined ? before.start + before.duration : (after?.start ?? 0);
    shiftAfter(track, place, length);
    const {
      id: _id,
      linkId: _link,
      fadeInFrames: _in,
      fadeOutFrames: _out,
      ...props
    } = before ?? after ?? {};
    track.items.push({
      ...props,
      id: allocateId(document, ITEM_PREFIX.video),
      media: mediaId,
      start: place,
      duration: length,
      in: from,
    });
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
      restoreOnTrack(document, track, op.mediaId, op.range);
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
      const found = withLinked(document, op.itemId);
      const target = op.toTrackId === undefined ? found.track : findTrack(document, op.toTrackId);
      if (target.kind !== found.track.kind) {
        fail(op.itemId, `"${op.itemId}" can only move to another ${found.track.kind} track.`);
      }
      const by = op.start - found.item.start;
      found.track.items.splice(found.index, 1);
      const moved = { ...found.item };
      shiftItem(moved, by);
      target.items.push(moved);
      // Linked items keep their own tracks and move by the same frames.
      for (const { item } of found.linked) shiftItem(item, by);
      return;
    }
    case "trimItem": {
      const { item, linked } = withLinked(document, op.itemId);
      const edgeFrame = op.edge === "start" ? item.start : item.start + item.duration;
      const by = op.frame - edgeFrame;
      trimOne(item, op.edge, op.frame);
      for (const other of linked) {
        const otherEdge =
          op.edge === "start" ? other.item.start : other.item.start + other.item.duration;
        trimOne(other.item, op.edge, otherEdge + by);
      }
      return;
    }
    case "splitItem": {
      const { track, item, linked } = withLinked(document, op.itemId);
      const end = item.start + item.duration;
      if (op.atFrame <= item.start || op.atFrame >= end) {
        fail(
          op.itemId,
          `Frame ${op.atFrame} is not inside "${op.itemId}" (${item.start} to ${end}).`,
        );
      }
      const taken = allIds(document);
      const id = op.newItemId ?? allocateId(document, ITEM_PREFIX[track.kind], taken);
      taken.add(id);
      const right = splitOne(track, item, op.atFrame, id);
      // Linked items under the cut split too; the right-hand parts get a link of their own.
      const parts = linked.filter(
        (other) =>
          other.item.start < op.atFrame && op.atFrame < other.item.start + other.item.duration,
      );
      if (parts.length > 0) {
        // A fresh id, never derived from the old one, so repeated splits stay unique and short.
        const linkIds = new Set(allIds(document));
        for (const entry of document.tracks.flatMap((each) => each.items)) {
          if (typeof entry.linkId === "string") linkIds.add(entry.linkId);
        }
        const rightLink = allocateId(document, "link", linkIds);
        right.linkId = rightLink;
        for (const other of parts) {
          const otherId = allocateId(document, ITEM_PREFIX[other.track.kind], taken);
          splitOne(other.track, other.item, op.atFrame, otherId).linkId = rightLink;
        }
      } else if ("linkId" in right) {
        delete right.linkId;
      }
      return;
    }
    case "deleteItem": {
      const ids: string[] = [];
      for (const itemId of op.itemIds) {
        const { item, linked } = withLinked(document, itemId);
        for (const entry of [item, ...linked.map((other) => other.item)]) {
          if (!ids.includes(entry.id)) ids.push(entry.id);
        }
      }
      for (const itemId of ids) {
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
    case "setCanvas": {
      const { width, height } = op.canvas;
      // The encoder needs even sides (export.py refuses odd ones), so refuse them here, early.
      if (!(width > 0 && height > 0) || width % 2 !== 0 || height % 2 !== 0) {
        fail(null, `The canvas needs even sides above 0, not ${width}×${height}.`);
      }
      document.canvas = { width, height };
      if (op.fromClip !== true) {
        document.metadata = { ...(document.metadata as object), canvasChosen: true };
      }
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
