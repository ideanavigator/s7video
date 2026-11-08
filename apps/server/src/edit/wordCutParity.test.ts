// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Reads the committed transcript fixture.
/**
 * S7V-038 confidence check 2: a text cut follows the silence-removal rules (S7V-027). Deleting
 * words cuts what `planSilenceCuts` would cut if those words were a quiet pause, on
 * talking-head-01's transcript.
 */
import { Transcript } from "@t3tools/contracts";
import { planWordCut } from "@t3tools/shared/editWordCuts";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

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
