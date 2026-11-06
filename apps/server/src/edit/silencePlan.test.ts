// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditRational } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AIR_SECONDS,
  MIN_SEGMENT_SECONDS,
  QUIET_MARGIN_DB,
  type SilencePlanInput,
  planSilenceCuts,
} from "./silencePlan.ts";

const SPEECH_DB = -20;
const ROOM_DB = -45;
const fps30: EditRational = { num: 30, den: 1 };

/** Words as [start, end) frames; every other frame is room tone unless `loud` says otherwise. */
function clip(
  words: ReadonlyArray<readonly [number, number]>,
  frames: number,
  options: Partial<SilencePlanInput> & {
    readonly loud?: ReadonlyArray<readonly [number, number, number]>;
  } = {},
): SilencePlanInput {
  const levels = Array.from({ length: frames }, () => ROOM_DB);
  for (const [from, to] of words) for (let at = from; at < to; at++) levels[at] = SPEECH_DB;
  for (const [from, to, db] of options.loud ?? [])
    for (let at = from; at < to; at++) levels[at] = db;
  return {
    words: words.map(([startFrame, endFrame]) => ({ startFrame, endFrame })),
    levels,
    sourceRate: fps30,
    sourceFrames: frames,
    documentRate: fps30,
    mediaFrames: frames,
    minGapSeconds: 0.4,
    keep: [],
    ...options,
  };
}

function planned(input: SilencePlanInput) {
  const plan = planSilenceCuts(input);
  if (plan._tag !== "planned") throw new Error(`expected a plan, got ${plan._tag}`);
  return plan;
}

const spans = (plan: ReturnType<typeof planned>) =>
  plan.ranges.map((range) => [range.in, range.in + range.duration]);

/** Every word, at document frames rounded outward, lies inside one keep range. */
function expectWordsKept(input: SilencePlanInput, plan: ReturnType<typeof planned>) {
  const scale = (frame: number, rate: EditRational) => (frame * rate.den) / rate.num;
  for (const word of input.words) {
    const start = scale(word.startFrame, input.sourceRate);
    const end = scale(word.endFrame, input.sourceRate);
    const holder = plan.ranges.find(
      (range) =>
        scale(range.in, input.documentRate) <= start &&
        scale(range.in + range.duration, input.documentRate) >= end,
    );
    expect(holder, `word ${word.startFrame}-${word.endFrame}`).toBeDefined();
  }
}

describe("silencePlan", () => {
  it("silencePlan removes gaps over the threshold", () => {
    // Gaps: lead-in 1 s, 1 s, 0.2 s (kept), tail 1.67 s.
    const input = clip(
      [
        [30, 60],
        [90, 120],
        [126, 150],
      ],
      200,
    );
    const plan = planned(input);
    expect(spans(plan)).toEqual([
      [27, 63],
      [87, 153],
    ]);
    expect(plan).toMatchObject({ cuts: 3, removedFrames: 98, shortestFrames: 36 });
  });

  it("silencePlan keeps air around words", () => {
    const air = Math.round(AIR_SECONDS * 30);
    const input = clip(
      [
        [30, 60],
        [90, 120],
      ],
      150,
    );
    const plan = planned(input);
    for (const word of input.words) {
      const range = plan.ranges.find(
        (entry) => entry.in <= word.startFrame && entry.in + entry.duration >= word.endFrame,
      )!;
      expect(word.startFrame - range.in).toBeGreaterThanOrEqual(air);
      expect(range.in + range.duration - word.endFrame).toBeGreaterThanOrEqual(air);
    }
  });

  it("silencePlan never cuts inside a word", () => {
    // A quiet word inside a long pause is still speech: the pause splits around it.
    const input = clip(
      [
        [30, 60],
        [100, 104],
        [150, 180],
      ],
      210,
      { loud: [[100, 104, -32]] },
    );
    const plan = planned(input);
    expectWordsKept(input, plan);
    expect(plan.cuts).toBe(4);
  });

  it("keeps a gap whose sound is near the speech level (laughter, music)", () => {
    const words: Array<readonly [number, number]> = [
      [30, 60],
      [100, 130],
    ];
    const laughing = planned(
      clip(words, 160, { loud: [[60, 100, SPEECH_DB - QUIET_MARGIN_DB + 1]] }),
    );
    expect(spans(laughing)[0]).toEqual([27, 133]);
    const quiet = planned(clip(words, 160, { loud: [[60, 100, SPEECH_DB - QUIET_MARGIN_DB - 1]] }));
    expect(spans(quiet).slice(0, 2)).toEqual([
      [27, 63],
      [97, 133],
    ]);
  });

  it("silencePlan enforces minimum segment", () => {
    const minimum = Math.ceil(MIN_SEGMENT_SECONDS * 30);
    // A two-frame word between two pauses would leave an 8-frame keep: it joins a neighbour.
    const input = clip(
      [
        [30, 60],
        [80, 82],
        [102, 140],
      ],
      170,
    );
    const plan = planned(input);
    expectWordsKept(input, plan);
    expect(plan.shortestFrames).toBeGreaterThanOrEqual(minimum);
    expect(spans(plan)).toEqual([
      [27, 85],
      [99, 143],
    ]);
  });

  it("silencePlan snaps to frames at 29.97 fps", () => {
    // Source at 23.976, edit at 29.97 and at 25: integer ranges that still hold every word.
    const source = { num: 24000, den: 1001 };
    const words: Array<readonly [number, number]> = [
      [17, 41],
      [61, 77],
      [101, 133],
      [134, 160],
    ];
    for (const documentRate of [
      { num: 30000, den: 1001 },
      { num: 25, den: 1 },
    ]) {
      const mediaFrames = Math.floor(
        (200 * documentRate.num * source.den) / (documentRate.den * source.num),
      );
      const input = clip(words, 200, { sourceRate: source, documentRate, mediaFrames });
      const plan = planned(input);
      for (const range of plan.ranges) {
        expect(Number.isInteger(range.in) && Number.isInteger(range.duration)).toBe(true);
        expect(range.in + range.duration).toBeLessThanOrEqual(mediaFrames);
      }
      expectWordsKept(input, plan);
      // The lead-in, two gaps and the tail; 133-134 is too short to cut.
      expect(plan.cuts).toBe(4);
    }
  });

  it("silencePlan applies explicit keeps last", () => {
    const words: Array<readonly [number, number]> = [
      [30, 60],
      [120, 150],
    ];
    const input = clip(words, 180, { keep: [{ fromFrame: 80, toFrame: 100 }] });
    const plan = planned(input);
    expect(plan.keptRequests).toBe(1);
    const covered = plan.ranges.some((range) => range.in <= 80 && range.in + range.duration >= 100);
    expect(covered).toBe(true);
    // The kept pause plays; the rest of that gap is still cut.
    expect(plan.removedFrames).toBeLessThan(planned(clip(words, 180)).removedFrames);
    expect(plan.removedFrames).toBeGreaterThan(0);
  });

  it("removes fewer pauses with a larger gap threshold", () => {
    const words: Array<readonly [number, number]> = [
      [30, 60],
      [75, 100],
      [140, 170],
    ];
    const tight = planned(clip(words, 200));
    const loose = planned(clip(words, 200, { minGapSeconds: 1 }));
    expect(loose.cuts).toBeLessThan(tight.cuts);
    expect(loose.removedFrames).toBeLessThan(tight.removedFrames);
  });

  it("should handle a clip with no silence", () => {
    const plan = planned(
      clip(
        [
          [0, 50],
          [52, 100],
        ],
        100,
      ),
    );
    expect(plan).toMatchObject({ cuts: 0, removedFrames: 0, ranges: [{ in: 0, duration: 100 }] });
  });

  it("should handle an all-silent clip", () => {
    expect(planSilenceCuts(clip([], 300))._tag).toBe("no-speech");
  });

  it("is the same plan for the same input", () => {
    const input = clip(
      [
        [30, 60],
        [90, 120],
      ],
      150,
      { keep: [{ fromFrame: 64, toFrame: 70 }] },
    );
    expect(planSilenceCuts(input)).toEqual(planSilenceCuts(input));
  });
});
