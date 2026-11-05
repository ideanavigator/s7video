// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { audioExpression, ffmpegArgs, synthPath, type SynthSpec } from "../fixtures/media/synth.ts";

const SPEC: SynthSpec = {
  name: "beeps",
  fps: "30000/1001",
  gop: 12,
  audio: [{ seconds: 1, toneHz: 1000, dbfs: -20 }, { seconds: 0.5 }],
};

describe("synth", () => {
  it("gates each tone to its own span and leaves silence at zero", () => {
    expect(audioExpression(SPEC.audio)).toBe("gte(t,0)*lt(t,1)*0.100000000*sin(2*PI*1000*t)");
    expect(audioExpression([{ seconds: 2 }])).toBe("0");
  });

  it("builds a fixed-GOP H.264 recipe at the chosen rate and length", () => {
    const args = ffmpegArgs(SPEC, "/cache/out.mp4");
    expect(args).toContain("testsrc2=size=320x180:rate=30000/1001:duration=1.5");
    expect(args.slice(args.indexOf("-g"), args.indexOf("-g") + 6)).toEqual([
      "-g",
      "12",
      "-keyint_min",
      "12",
      "-sc_threshold",
      "0",
    ]);
    expect(args.at(-1)).toBe("/cache/out.mp4");
  });

  it("makes audio-only WAV without a video input", () => {
    const args = ffmpegArgs({ ...SPEC, container: "wav" }, "/cache/out.wav");
    expect(args.join(" ")).not.toContain("testsrc2");
    expect(args).toContain("pcm_s16le");
  });

  it("keys the cache path on the whole spec", () => {
    expect(synthPath(SPEC, "/c")).toMatch(/^\/c\/synth\/beeps-[0-9a-f]{12}\.mp4$/);
    expect(synthPath(SPEC, "/c")).toBe(synthPath({ ...SPEC }, "/c"));
    expect(synthPath({ ...SPEC, gop: 13 }, "/c")).not.toBe(synthPath(SPEC, "/c"));
  });

  it("rejects specs that cannot make a clip", () => {
    expect(() => ffmpegArgs({ ...SPEC, audio: [] }, "x.mp4")).toThrow("at least one segment");
    expect(() => ffmpegArgs({ ...SPEC, fps: "30" }, "x.mp4")).toThrow("rational");
    expect(() => ffmpegArgs({ ...SPEC, name: "Bad Name" }, "x.mp4")).toThrow("name");
  });
});
