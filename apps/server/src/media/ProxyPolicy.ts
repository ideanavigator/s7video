// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * When a clip gets a preview proxy (spike A2): never by default, only when the player would seek
 * it badly or cannot play it. The codec and container lists come from what Electron 44 (Chromium
 * 152) on Apple Silicon decodes in hardware (S7V-025 confidence check 3).
 */
import type { MediaKeyframesResult, MediaProbeResult } from "@t3tools/contracts";

export type ProxyReason = "long-gop" | "codec" | "container" | "above-4k" | "4k-high-fps";

/** Keyframe gaps above this seek slowly: a 10 s GOP gave 462 ms median seeks, a 1 s GOP 103 ms. */
const MAX_KEYFRAME_GAP_SECONDS = 2;
const UHD_PIXELS = 3840 * 2160;
const DCI_4K_PIXELS = 4096 * 2160;
const MAX_4K_FPS = 60;

/** Hardware decoded in Chromium on Apple Silicon. */
const PLAYABLE_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);
/** 4:2:0 only; H.264 at 10 bit or 4:2:2 decodes in software and drops frames at 4K. */
const PLAYABLE_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p", "nv12"]);
const PLAYABLE_10_BIT_FORMATS = new Set(["yuv420p10le", "p010le"]);
/** ffprobe `format_name`s whose demuxers Chromium has: MP4/MOV and Matroska/WebM. */
const PLAYABLE_CONTAINERS = ["mp4", "mov", "matroska", "webm"];

export interface ProxyPolicyInput {
  readonly probe: MediaProbeResult;
  readonly keyframes: MediaKeyframesResult | undefined;
}

export const proxyReasons = ({
  probe,
  keyframes,
}: ProxyPolicyInput): ReadonlyArray<ProxyReason> => {
  const video = probe.video;
  if (video === null) return [];
  const reasons: ProxyReason[] = [];
  if (
    keyframes !== undefined &&
    // gap × num / den > 2 s, compared in integers.
    keyframes.maxGapTicks * keyframes.timeBase.num >
      MAX_KEYFRAME_GAP_SECONDS * keyframes.timeBase.den
  ) {
    reasons.push("long-gop");
  }
  const pixelFormat = video.pixelFormat ?? "";
  const playablePixels =
    PLAYABLE_PIXEL_FORMATS.has(pixelFormat) ||
    (video.codec !== "h264" && PLAYABLE_10_BIT_FORMATS.has(pixelFormat));
  if (!PLAYABLE_CODECS.has(video.codec) || !playablePixels) reasons.push("codec");
  const containers = probe.container.split(",");
  if (!PLAYABLE_CONTAINERS.some((name) => containers.includes(name))) reasons.push("container");
  const pixels = video.width * video.height;
  if (pixels > DCI_4K_PIXELS) reasons.push("above-4k");
  else if (pixels >= UHD_PIXELS && video.frameRate.num > MAX_4K_FPS * video.frameRate.den) {
    reasons.push("4k-high-fps");
  }
  return reasons;
};
