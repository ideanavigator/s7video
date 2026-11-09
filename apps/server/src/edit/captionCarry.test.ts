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
import {
  type CaptionTranscript,
  captionItemsFor,
  captionTrackOps,
  carryCaptions,
} from "@t3tools/shared/captionWords";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";

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
const BOTH = new Map([
  ["a", transcript("a")],
  ["b", transcript("b")],
]);
/** `b`'s transcript can no longer be read: its drive is unplugged, or the cache was cleared. */
const ONLY_A = new Map([["a", transcript("a")]]);

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
      media: [media("a"), media("b")],
      tracks: [{ kind: "video", id: "V1", items: [] }],
      markers: [],
      metadata: {},
    },
    items.map((item) => ({ _tag: "insertItem" as const, trackId: "V1", item })),
  );
  return applied(placed, captionTrackOps(placed, BOTH));
};

const captionTrack = (document: EditDocument) =>
  document.tracks.find((track) => track.kind === "caption")!;

/** The rebuild after `ops`, as `rebuildCaptionOps` merges it with `b` unreadable; then validated. */
const cut = (before: EditDocument, ops: ReadonlyArray<EditOp>) => {
  const after = applied(before, ops);
  const rebuilt = captionItemsFor(after, ONLY_A);
  const kept = captionTrack(before).items.filter(
    (item) => (item.metadata as { s7?: { media?: string } } | undefined)?.s7?.media === "b",
  );
  const captions = [...rebuilt, ...carryCaptions(before, after, kept, rebuilt)].toSorted(
    (left, right) => left.start - right.start,
  );
  const document = applied(after, [{ _tag: "setCaptions", trackId: "C1", captions }]);
  return { document, validation: validateEditDocument(document), rebuilt, captions };
};

const textsOf = (document: EditDocument) =>
  captionTrack(document).items.flatMap((item) => item.text.split(" "));

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

  it("gives a valid edit after any cut while b is unreadable (200 seeded edits)", () => {
    let state = 75;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    const pick = <T>(values: ReadonlyArray<T>) => values[Math.floor(random() * values.length)]!;
    let checked = 0;
    for (let round = 0; round < 200; round++) {
      // 2-5 parts of a and b, end to end, some splits that continue their source.
      const items: EditVideoItem[] = [];
      let at = 0;
      const sources = { a: 0, b: 0 };
      for (let index = 0; index < 2 + Math.floor(random() * 4); index++) {
        const from = pick(["a", "b"] as const);
        const duration = 30 + Math.floor(random() * 250);
        items.push({ id: `v${index + 1}`, media: from, start: at, duration, in: sources[from] });
        at += duration;
        sources[from] += duration + (random() < 0.5 ? 0 : Math.floor(random() * 100));
      }
      const before = captioned(items);
      const target = pick(items);
      const ops: EditOp[] = pick([
        () => [
          {
            _tag: "trimItem",
            itemId: target.id,
            edge: "end",
            frame: target.start + 1 + Math.floor(random() * (target.duration - 1)),
          },
        ],
        () => [
          {
            _tag: "trimItem",
            itemId: target.id,
            edge: "start",
            frame: target.start + Math.floor(random() * (target.duration - 1)),
          },
        ],
        () => [{ _tag: "deleteItem", itemIds: [target.id], ripple: true }],
        () => [{ _tag: "deleteItem", itemIds: [target.id], ripple: false }],
        () => [
          {
            _tag: "splitItem",
            itemId: target.id,
            atFrame: target.start + 1 + Math.floor(random() * (target.duration - 1)),
          },
        ],
        () => [{ _tag: "moveItem", itemId: target.id, start: at + Math.floor(random() * 100) }],
        () => [
          {
            _tag: "setKeepRanges",
            trackId: "V1",
            mediaId: target.media,
            ranges: [
              { in: 0, duration: 40 + Math.floor(random() * 100) },
              { in: 200 + Math.floor(random() * 100), duration: 40 + Math.floor(random() * 200) },
            ],
            start: at + 10,
          },
        ],
      ] satisfies ReadonlyArray<() => EditOp[]>)();
      const result = applyEditOps(before, ops);
      // A gesture the edit refuses on its own (an overlap) is not a cut to check.
      if (result._tag === "failed" || !validateEditDocument(result.document).ok) continue;
      const { validation } = cut(before, ops);
      expect(
        validation.ok ? [] : validation.issues,
        `round ${round}: ${JSON.stringify(ops)}`,
      ).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });
});
