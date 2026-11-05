// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { MediaKeyframesResult, MediaProbeResult, MediaProbeVideo } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { proxyReasons } from "./ProxyPolicy.ts";

const video = (overrides: Partial<MediaProbeVideo> = {}): MediaProbeVideo => ({
  index: 0,
  codec: "h264",
  profile: "High",
  width: 1920,
  height: 1080,
  pixelFormat: "yuv420p",
  frameRate: { num: 30, den: 1 },
  averageFrameRate: { num: 30, den: 1 },
  variableFrameRate: false,
  timeBase: { num: 1, den: 15_360 },
  firstPts: 0,
  lastPts: 153_088,
  frameCount: 300,
  durationFrames: 300,
  rotation: 0,
  color: { space: null, transfer: null, primaries: null, range: null },
  ...overrides,
});

const probe = (overrides: Partial<MediaProbeVideo> = {}, container = "mov,mp4,m4a,3gp,3g2,mj2") =>
  ({
    path: "/clip",
    container,
    sizeBytes: 1,
    bitRate: null,
    durationFrames: 300,
    video: video(overrides),
    audio: null,
  }) satisfies MediaProbeResult;

/** A keyframe every `seconds`, in a 1/15360 time base. */
const gop = (seconds: number): MediaKeyframesResult => ({
  timeBase: { num: 1, den: 15_360 },
  maxGapTicks: seconds * 15_360,
  keyframes: 10,
  scannedTicks: 30 * 15_360,
});

describe("ProxyPolicy", () => {
  it("proxies long GOP, above 4K, 4K above 60 fps, and leaves a clean 1080p file alone", () => {
    expect(proxyReasons({ probe: probe(), keyframes: gop(1) })).toEqual([]);
    expect(proxyReasons({ probe: probe(), keyframes: gop(2) })).toEqual([]);
    expect(proxyReasons({ probe: probe(), keyframes: gop(10) })).toEqual(["long-gop"]);
    // Ordinary 4K at 30 or 60 fps plays from the original (spike A2: 103 ms median seek).
    const uhd = { width: 3840, height: 2160 };
    expect(proxyReasons({ probe: probe(uhd), keyframes: gop(1) })).toEqual([]);
    expect(
      proxyReasons({ probe: probe({ ...uhd, frameRate: { num: 60, den: 1 } }), keyframes: gop(1) }),
    ).toEqual([]);
    expect(
      proxyReasons({
        probe: probe({ ...uhd, frameRate: { num: 120, den: 1 } }),
        keyframes: gop(1),
      }),
    ).toEqual(["4k-high-fps"]);
    expect(
      proxyReasons({ probe: probe({ width: 6144, height: 3456 }), keyframes: gop(1) }),
    ).toEqual(["above-4k"]);
    // Portrait 4K counts the same.
    expect(
      proxyReasons({
        probe: probe({ width: 2160, height: 3840, frameRate: { num: 120, den: 1 } }),
        keyframes: gop(1),
      }),
    ).toEqual(["4k-high-fps"]);
  });

  it("proxies codecs and containers Chromium cannot play smoothly", () => {
    expect(proxyReasons({ probe: probe({ codec: "prores" }), keyframes: gop(1) })).toEqual([
      "codec",
    ]);
    expect(
      proxyReasons({ probe: probe({ pixelFormat: "yuv422p10le" }), keyframes: gop(1) }),
    ).toEqual(["codec"]);
    // 10-bit 4:2:0 is fine for HEVC (iPhone HDR) but decodes in software as H.264.
    expect(
      proxyReasons({
        probe: probe({ codec: "hevc", pixelFormat: "yuv420p10le" }),
        keyframes: gop(1),
      }),
    ).toEqual([]);
    expect(
      proxyReasons({ probe: probe({ pixelFormat: "yuv420p10le" }), keyframes: gop(1) }),
    ).toEqual(["codec"]);
    expect(proxyReasons({ probe: probe({}, "avi"), keyframes: gop(1) })).toEqual(["container"]);
    expect(proxyReasons({ probe: probe({}, "matroska,webm"), keyframes: gop(1) })).toEqual([]);
  });

  it("never proxies audio, and judges GOP only when it was measured", () => {
    const audio = { ...probe(), video: null };
    expect(proxyReasons({ probe: audio, keyframes: gop(10) })).toEqual([]);
    expect(proxyReasons({ probe: probe(), keyframes: undefined })).toEqual([]);
  });
});
