// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-075 review: captions of a clip whose transcript can't be read are carried through a cut
 * (`carryCaptions`) and never overlap the rebuilt captions, so every cut still gives a valid edit.
 * Runs the rebuild's merge on the real ops (`applyEditOps`) and validator, without files.
 */
import {
  type EditDocument,
  type EditOp,
  type EditVideoItem,
  validateEditDocument,
} from "@t3tools/contracts";
import { type CaptionTranscript, captionTrackOps } from "@t3tools/shared/captionWords";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";
import { mergeCaptionTrack } from "./captionTrack.ts";

const FPS = { num: 30, den: 1 };

const media = (id: string) => ({
  id,
  kind: "video" as const,
  path: `assets/${id}.mp4`,
  fingerprint: { sha256: "ab".repeat(32), size: 1 },
  probe: { durationFrames: 3000, hasVideo: true, hasAudio: true, fps: FPS },
});

/** A word every 20 frames, 15 long, with a full stop every fourth word. */
const transcript = (media: string): CaptionTranscript => ({
  fps: FPS,
  words: Array.from({ length: 140 }, (_, index) => ({
    text: `${media}${index}${index % 4 === 3 ? "." : ""}`,
    startFrame: index * 20,
    endFrame: index * 20 + 15,
  })),
});
const MEDIA = ["a", "b", "c", "d"] as const;
const ALL = new Map(MEDIA.map((id) => [id, transcript(id)]));

const applied = (document: EditDocument, ops: ReadonlyArray<EditOp>) => {
  const result = applyEditOps(document, ops);
  if (result._tag === "failed") throw result.error;
  return result.document;
};

/** The edit with both clips placed as `items`, captioned while both transcripts could be read. */
const captioned = (items: ReadonlyArray<EditVideoItem>): EditDocument => {
  const placed = applied(
    {
      version: 1,
      fps: FPS,
      canvas: { width: 1080, height: 1920 },
      media: MEDIA.map(media),
      tracks: [{ kind: "video", id: "V1", items: [] }],
      markers: [],
      metadata: {},
    },
    items.map((item) => ({ _tag: "insertItem" as const, trackId: "V1", item })),
  );
  return applied(placed, captionTrackOps(placed, ALL));
};

const captionTrack = (document: EditDocument) =>
  document.tracks.find((track) => track.kind === "caption")!;

/** The rebuild after `ops`, by `rebuildCaptionOps`'s own merge, with `unreadable` clips; validated. */
const cut = (
  before: EditDocument,
  ops: ReadonlyArray<EditOp>,
  unreadable: ReadonlyArray<string> = ["b"],
) => {
  const after = applied(before, ops);
  const readable = new Map([...ALL].filter(([id]) => !unreadable.includes(id)));
  const captions = mergeCaptionTrack(before, after, captionTrack(before), readable, unreadable);
  const document = applied(after, [{ _tag: "setCaptions", trackId: "C1", captions }]);
  return { document, validation: validateEditDocument(document), captions };
};

/** Captions whose words don't ascend, or that span more than their words: none may stretch. */
const loose = (document: EditDocument) =>
  captionTrack(document).items.filter((item) => {
    const words = item.words ?? [];
    const ascending = words.every(
      (word, index) =>
        index === 0 || word.start >= words[index - 1]!.start + words[index - 1]!.duration,
    );
    const end = Math.max(...words.map((word) => word.start + word.duration));
    return !(ascending && words[0]?.start === item.start && end === item.start + item.duration);
  });

const textsOf = (document: EditDocument) =>
  captionTrack(document).items.flatMap((item) => item.text.split(" "));

const placementsOf = (document: EditDocument, media: string) =>
  document.tracks
    .find((track) => track.kind === "video")!
    .items.filter((item) => item.media === media);

/** The clip and the source frames a word's text names (`b12` is b's frames 240-255). */
const sourceOf = (text: string) => {
  const media = text[0]!;
  const index = Number.parseInt(text.slice(1), 10);
  return { media, from: index * 20, to: index * 20 + 15 };
};

/**
 * Broken promises after a cut: a carried caption not inside one video item of its clip, or with a
 * word showing frames its source doesn't play there; or a word dropped while some of its source
 * still plays on frames no caption uses.
 */
const violations = (
  before: EditDocument,
  after: EditDocument,
  unreadable: ReadonlyArray<string>,
): string[] => {
  const problems: string[] = [];
  const items = captionTrack(after).items;
  for (const caption of items) {
    const media = (caption.metadata as { s7?: { media?: string } } | undefined)?.s7?.media ?? "";
    if (!unreadable.includes(media)) continue;
    const home = placementsOf(after, media).find(
      (item) =>
        item.start <= caption.start &&
        caption.start + caption.duration <= item.start + item.duration,
    );
    if (home === undefined) {
      problems.push(`"${caption.text}" is not inside one item of ${media}`);
      continue;
    }
    for (const word of caption.words ?? []) {
      const source = sourceOf(word.text);
      const from = word.start - home.start + home.in;
      if (from < source.from || from + word.duration > source.to) {
        problems.push(`"${word.text}" shows source ${from}, not ${source.from}-${source.to}`);
      }
    }
  }
  const shown = new Set(items.flatMap((item) => (item.words ?? []).map((word) => word.text)));
  // What each word may still show: a readable clip's whole word (from its transcript); an
  // unreadable clip's only the source frames its caption showed before the cut.
  const candidates = new Map<string, { media: string; from: number; to: number }>();
  for (const [id, entry] of ALL) {
    if (unreadable.includes(id)) continue;
    for (const word of entry.words) candidates.set(word.text, sourceOf(word.text));
  }
  for (const word of captionTrack(before).items.flatMap((item) => item.words ?? [])) {
    const media = word.text[0]!;
    if (!unreadable.includes(media)) continue;
    const item = placementsOf(before, media).find(
      (entry) =>
        entry.start <= word.start && word.start + word.duration <= entry.start + entry.duration,
    );
    if (item === undefined) continue;
    const from = word.start - item.start + item.in;
    candidates.set(word.text, { media, from, to: from + word.duration });
  }
  for (const [text, source] of candidates) {
    if (shown.has(text)) continue;
    for (const item of placementsOf(after, source.media)) {
      const low = Math.max(source.from, item.in);
      const high = Math.min(source.to, item.in + item.duration);
      if (high <= low) continue;
      const from = low - item.in + item.start;
      const to = high - item.in + item.start;
      const taken = items.some((other) => other.start < to && from < other.start + other.duration);
      if (!taken) problems.push(`"${text}" was dropped though ${from}-${to} plays and is free`);
    }
  }
  return problems;
};

describe("captions of an unreadable clip through a cut (S7V-075)", () => {
  it("follows the reviewer's case: b unreadable then a; trimming b to 120 frames stays valid", () => {
    const before = captioned([
      { id: "v1", media: "b", start: 0, duration: 240, in: 0 },
      { id: "v2", media: "a", start: 240, duration: 240, in: 0 },
    ]);
    // A ripple trim: the end comes in, and a moves left after it.
    const { document, validation } = cut(before, [
      { _tag: "trimItem", itemId: "v1", edge: "end", frame: 120 },
      { _tag: "moveItem", itemId: "v2", start: 120 },
    ]);
    expect(validation.ok).toBe(true);
    const words = textsOf(document);
    // b's words past frame 120 are gone; a's words moved with a; nothing is duplicated.
    expect(words).toContain("b0");
    expect(words).not.toContain("b6");
    expect(words).toContain("a0");
    const a0 = captionTrack(document).items.find((item) => item.text.startsWith("a0"))!;
    expect(a0.start).toBe(120);
  });

  it("clips and shifts b's captions when b itself is cut shorter at its start", () => {
    const before = captioned([
      { id: "v1", media: "a", start: 0, duration: 200, in: 0 },
      { id: "v2", media: "b", start: 200, duration: 300, in: 0 },
    ]);
    const { document, validation } = cut(before, [
      { _tag: "trimItem", itemId: "v2", edge: "start", frame: 300 },
    ]);
    expect(validation.ok).toBe(true);
    const items = captionTrack(document).items.filter((item) => item.text.startsWith("b"));
    // b now plays source frames 100-300 from timeline 300: "b5" (source 100) sits at 300.
    expect(items[0]!.words![0]).toEqual({ text: "b5", start: 300, duration: 15 });
    expect(items.every((item) => item.start >= 300)).toBe(true);
    expect(textsOf(document)).not.toContain("b4.");
  });

  it("splits b's captions when its parts are reordered, instead of stretching one over the gap", () => {
    // The reviewer's swap: b split at 100, its first part moved after its second.
    const before = captioned([
      { id: "v1", media: "b", start: 0, duration: 100, in: 0 },
      { id: "v2", media: "b", start: 100, duration: 200, in: 100 },
    ]);
    const { document, validation } = cut(before, [
      { _tag: "moveItem", itemId: "v2", start: 0 },
      { _tag: "moveItem", itemId: "v1", start: 200 },
    ]);
    expect(validation.ok).toBe(true);
    expect(loose(document)).toEqual([]);
    const words = captionTrack(document).items.flatMap((item) => item.words ?? []);
    // Every word still plays, where its source now plays.
    expect(words.map((word) => word.text).toSorted()).toEqual(
      Array.from({ length: 15 }, (_, index) => `b${index}${index % 4 === 3 ? "." : ""}`).toSorted(),
    );
    expect(words.find((word) => word.text === "b4")).toEqual({
      text: "b4",
      start: 280,
      duration: 15,
    });
    expect(words.find((word) => word.text === "b5")).toEqual({
      text: "b5",
      start: 0,
      duration: 15,
    });
  });

  it("drops b's captions with b, and keeps the rest valid, when b is deleted", () => {
    const before = captioned([
      { id: "v1", media: "b", start: 0, duration: 200, in: 0 },
      { id: "v2", media: "a", start: 200, duration: 200, in: 0 },
    ]);
    const { document, validation } = cut(before, [
      { _tag: "deleteItem", itemIds: ["v1"], ripple: true },
    ]);
    expect(validation.ok).toBe(true);
    expect(textsOf(document).some((word) => word.startsWith("b"))).toBe(false);
  });

  it("keeps each carried caption inside one item when a lifted gap is filled by another clip", () => {
    // The reviewer's lift-then-fill: b and c unreadable; a piece of b lifted out, c moved in.
    let document = captioned([
      { id: "v1", media: "b", start: 0, duration: 300, in: 0 },
      { id: "c1", media: "c", start: 300, duration: 40, in: 0 },
    ]);
    const step = (ops: ReadonlyArray<EditOp>) => {
      const result = cut(document, ops, ["b", "c"]);
      expect(violations(document, result.document, ["b", "c"])).toEqual([]);
      document = result.document;
    };
    step([{ _tag: "splitItem", itemId: "v1", atFrame: 100 }]);
    const middle = () => document.tracks[0]!.items.find((item) => item.start === 100)!.id;
    step([{ _tag: "splitItem", itemId: middle(), atFrame: 120 }]);
    step([{ _tag: "deleteItem", itemIds: [middle()], ripple: false }]);
    step([{ _tag: "trimItem", itemId: "c1", edge: "end", frame: 320 }]);
    step([{ _tag: "moveItem", itemId: "c1", start: 100 }]);
    const words = captionTrack(document).items.flatMap((item) => item.words ?? []);
    expect(words.map((word) => word.text)).toContain("c0");
  });

  it("keeps every carried caption in one item and drops no free word (500 seeds, 2-3 unreadable clips)", () => {
    let state = 75;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    const pick = <T>(values: ReadonlyArray<T>) => values[Math.floor(random() * values.length)]!;
    const between = (low: number, high: number) => low + Math.floor(random() * (high - low));
    let steps = 0;
    for (let round = 0; round < 500; round++) {
      const unreadable = MEDIA.filter((id) => id !== "a" && random() < 0.8).slice(0, 3);
      if (unreadable.length < 2)
        unreadable.push(...(["b", "c"] as const).filter((id) => !unreadable.includes(id)));
      // 3-6 parts of the four clips, end to end, some continuing their source (a split).
      const items: EditVideoItem[] = [];
      let at = 0;
      const sources: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
      for (let index = 0; index < between(3, 7); index++) {
        const from = pick(MEDIA);
        const duration = between(30, 260);
        items.push({ id: `v${index + 1}`, media: from, start: at, duration, in: sources[from]! });
        at += duration;
        sources[from]! += duration + (random() < 0.5 ? 0 : between(0, 100));
      }
      let document = captioned(items);
      for (let move = 0; move < between(1, 4); move++) {
        const placed = document.tracks.find((track) => track.kind === "video")!.items;
        const end = Math.max(...placed.map((item) => item.start + item.duration));
        const target = pick(placed);
        const inside = () => target.start + between(1, Math.max(2, target.duration));
        const ops: EditOp[] = pick([
          () => [{ _tag: "trimItem", itemId: target.id, edge: "end", frame: inside() }],
          () => [{ _tag: "trimItem", itemId: target.id, edge: "start", frame: inside() - 1 }],
          () => [{ _tag: "deleteItem", itemIds: [target.id], ripple: random() < 0.5 }],
          () => [{ _tag: "splitItem", itemId: target.id, atFrame: inside() }],
          () => [{ _tag: "moveItem", itemId: target.id, start: between(0, end + 100) }],
          () => [
            {
              _tag: "setKeepRanges",
              trackId: "V1",
              mediaId: target.media,
              ranges: [
                { in: 0, duration: between(40, 140) },
                { in: between(200, 300), duration: between(40, 240) },
              ],
              start: end + 10,
            },
          ],
        ] satisfies ReadonlyArray<() => EditOp[]>)();
        const result = applyEditOps(document, ops);
        // A gesture the edit refuses on its own (an overlap) is not a cut to check.
        if (result._tag === "failed" || !validateEditDocument(result.document).ok) continue;
        const next = cut(document, ops, unreadable);
        const where = `round ${round} move ${move}: ${JSON.stringify(ops)}`;
        expect(next.validation.ok ? [] : next.validation.issues, where).toEqual([]);
        expect(loose(next.document), where).toEqual([]);
        expect(violations(document, next.document, unreadable), where).toEqual([]);
        document = next.document;
        steps += 1;
      }
    }
    expect(steps).toBeGreaterThan(700);
  });
});
