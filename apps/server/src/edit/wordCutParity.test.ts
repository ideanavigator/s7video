// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Reads the committed transcript fixture.
/**
 * S7V-038 confidence check 2: a text cut follows the silence-removal rules (S7V-027). Deleting
 * words cuts what `planSilenceCuts` would cut if those words were a quiet pause, on
 * talking-head-01's transcript. S7V-078 confidence check 2: on a clip laid in source order end to
 * end, cutting the removed frames in place keeps the same frames as `setKeepRanges`.
 */
import { type EditDocument, type EditOp, Transcript } from "@t3tools/contracts";
import { cutRangesOps, planWordCut } from "@t3tools/shared/editWordCuts";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { applyEditOps } from "./applyEditOps.ts";
import { planSilenceCuts } from "./silencePlan.ts";

const TRANSCRIPT = NodePath.resolve(
  import.meta.dirname,
  "../../../../fixtures/media/talking-head-01.transcript.json",
);
const transcript = Schema.decodeSync(Schema.fromJsonString(Transcript))(
  NodeFS.readFileSync(TRANSCRIPT, "utf8"),
);

/** A fixed sequence, so the 20 selections are the same on every run. */
function* seeded(seed: number) {
  let state = seed;
  for (;;) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    yield state / 2 ** 31;
  }
}

describe("text cuts match silence removal", () => {
  it("should match S7V-027 cut rules on shared fixtures", () => {
    const fps = transcript.fps;
    const length = transcript.durationFrames;
    const words = transcript.words.map((word) => ({ start: word.startFrame, end: word.endFrame }));
    const air = Math.round((0.1 * fps.num) / fps.den);
    const random = seeded(38);
    let checked = 0;
    while (checked < 20) {
      const first = 1 + Math.floor(random.next().value! * (words.length - 8));
      const last = first + Math.floor(random.next().value! * 5);
      const previous = words[first - 1]!;
      const next = words[last + 1]!;
      // Where the gaps leave room for the air on both sides, as a cut pause has.
      if (previous.end + air > words[first]!.start || next.start - air < words[last]!.end) {
        continue;
      }
      const cut = planWordCut({
        words,
        first,
        last,
        kept: [[0, length]],
        mediaFrames: length,
        fps,
      });
      // The same words as a pause: quiet from the word before to the word after, speech elsewhere.
      const levels = Array.from({ length }, (_, frame) =>
        frame >= previous.end && frame < next.start ? -60 : -20,
      );
      const plan = planSilenceCuts({
        words: transcript.words.filter((_, index) => index < first || index > last),
        levels,
        sourceRate: fps,
        sourceFrames: length,
        documentRate: fps,
        mediaFrames: length,
        minGapSeconds: 0.01,
        keep: [],
      });
      if (plan._tag !== "planned") throw new Error("expected a plan");
      const kept = plan.ranges.map((range) => [range.in, range.in + range.duration]);
      expect(kept).toHaveLength(2);
      expect(cut?.range).toEqual([kept[0]![1], kept[1]![0]]);
      expect(cut?.widenedFrames).toBe(0);
      checked += 1;
    }
  });
});

type Span = readonly [number, number];

/** Which source frame each timeline frame of `cam` plays on V1. */
function framesOf(document: EditDocument): Map<number, number> {
  const frames = new Map<number, number>();
  for (const item of document.tracks.find((track) => track.id === "V1")!.items) {
    if (!("in" in item) || item.media !== "cam" || item.in === undefined) continue;
    for (let offset = 0; offset < item.duration; offset++) {
      frames.set(item.start + offset, item.in + offset);
    }
  }
  return frames;
}

const applied = (document: EditDocument, ops: ReadonlyArray<EditOp>) => {
  const result = applyEditOps(document, ops);
  if (result._tag === "failed") throw new Error(result.error.explanation);
  return result.document;
};

describe("silence removal in place matches setKeepRanges on in-order clips (S7V-078)", () => {
  it("keeps the same frames on 20 seeded in-order edits", () => {
    const random = seeded(78);
    const next = (below: number) => Math.floor(random.next().value! * below);
    for (let run = 0; run < 20; run++) {
      const length = 600 + next(600);
      // Pieces in source order, end to end from a seeded start, with earlier cuts between them.
      const pieces: Span[] = [];
      for (let at = next(40); at < length - 20;) {
        const to = Math.min(length, at + 20 + next(150));
        pieces.push([at, to]);
        at = to + next(3) * (5 + next(40));
      }
      // Keep ranges as the plan gives them: inside what plays, in order, none touching.
      const kept: Span[] = [];
      for (const [from, to] of pieces) {
        for (let at = from + next(10); at < to;) {
          const end = Math.min(to, at + 5 + next(60));
          if (kept.at(-1)?.[1] !== at) kept.push([at, end]);
          at = end + 1 + next(25);
        }
      }
      const offset = next(100);
      const document: EditDocument = applied(
        {
          version: 1,
          fps: { num: 30, den: 1 },
          canvas: { width: 1080, height: 1920 },
          media: [
            {
              id: "cam",
              kind: "video",
              path: "assets/cam.mov",
              fingerprint: { sha256: "cd".repeat(32), size: 10 },
              probe: { durationFrames: length, hasVideo: true, hasAudio: true },
            },
          ],
          tracks: [{ kind: "video", id: "V1", items: [] }],
          markers: [],
          metadata: {},
        },
        [
          {
            _tag: "setKeepRanges",
            trackId: "V1",
            mediaId: "cam",
            ranges: pieces.map(([from, to]) => ({ in: from, duration: to - from })),
            start: offset,
          },
        ],
      );
      const relaid = applied(document, [
        {
          _tag: "setKeepRanges",
          trackId: "V1",
          mediaId: "cam",
          ranges: kept.map(([from, to]) => ({ in: from, duration: to - from })),
          start: offset,
        },
      ]);
      // The removed frames: what plays now minus the keeps.
      const removed: Span[] = pieces.flatMap(([from, to]) => {
        const holes: Span[] = [];
        let at = from;
        for (const [a, b] of kept) {
          if (b <= at || a >= to) continue;
          if (a > at) holes.push([at, a]);
          at = Math.max(at, b);
        }
        if (at < to) holes.push([at, to]);
        return holes;
      });
      const inPlace = applied(document, cutRangesOps(document, "cam", removed));
      expect(framesOf(inPlace), `run ${run}`).toEqual(framesOf(relaid));
      expect(framesOf(inPlace).size).toBe(kept.reduce((sum, [a, b]) => sum + b - a, 0));
    }
  });
});
