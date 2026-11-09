// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Synthetic media data for 30 minutes at 30 fps, as the engine writes it (S7V-035): a waveform
 * with a tone 12 s of every 20, and filmstrip sheets whose tile in column `c` is a flat colour, so
 * a drawn slot shows which tile it is. Served from blob URLs; nothing is decoded or fetched.
 */
import type { AssetResource, MediaFilmstripIndex, MediaPeaksIndex } from "@t3tools/contracts";

const SAMPLES = 30 * 60 * 48_000;
const LEVELS = [256, 1024, 4096, 16_384];

export const peaksIndex: MediaPeaksIndex = {
  version: 1,
  audio: true,
  sampleRate: 48_000,
  channels: 1,
  durationSamples: SAMPLES,
  offsetSamples: 0,
  levels: LEVELS.map((samplesPerPeak) => ({
    samplesPerPeak,
    count: Math.ceil(SAMPLES / samplesPerPeak),
    file: `${samplesPerPeak}.f32`,
  })),
};

const loud = (sample: number) => sample % (20 * 48_000) < 12 * 48_000;

export const levelBytes = (samplesPerPeak: number) => {
  const count = Math.ceil(SAMPLES / samplesPerPeak);
  const pairs = new Float32Array(count * 2);
  for (let peak = 0; peak < count; peak += 1) {
    const level = loud(peak * samplesPerPeak) ? 0.6 : 0;
    pairs[peak * 2] = -level;
    pairs[peak * 2 + 1] = level;
  }
  return pairs;
};

export const stripLevel = (seconds: number) => {
  const tiles = Math.ceil(1800 / seconds);
  return {
    level: `${seconds}s`,
    secondsPerTile: seconds,
    framesPerTile: seconds * 30,
    sheets: Array.from({ length: Math.ceil(tiles / 100) }, (_, n) => `${seconds}s-${n + 1}.jpg`),
    frames: Array.from({ length: tiles }, (_, tile) => tile * seconds * 30),
  };
};

export const filmstripIndex: MediaFilmstripIndex = {
  version: 1,
  video: true,
  rate: { num: 30, den: 1 },
  tileWidth: 160,
  tileHeight: 90,
  columns: 10,
  rows: 10,
  levels: [stripLevel(16), stripLevel(4), stripLevel(1)],
};

export const sheetCanvas = () => {
  const canvas = new OffscreenCanvas(1600, 900);
  const context = canvas.getContext("2d")!;
  for (let column = 0; column < 10; column += 1) {
    context.fillStyle = `rgb(${column * 25}, 0, ${255 - column * 25})`;
    context.fillRect(column * 160, 0, 160, 900);
  }
  return canvas;
};

/**
 * A blob URL per `project-media` part, made once and kept for the test file; the page that holds
 * them goes with the run.
 */
export function makeMediaDataServer() {
  const served = new Map<string, Promise<string>>();
  return (resource: AssetResource): Promise<string> | null => {
    if (resource._tag !== "project-media" || resource.part === undefined) return null;
    const { variant, part } = resource;
    const key = `${variant}/${part}`;
    let url = served.get(key);
    if (url === undefined) {
      url = (async () => {
        if (part === "index") {
          const index = variant === "peaks" ? peaksIndex : filmstripIndex;
          return URL.createObjectURL(
            new Blob([JSON.stringify(index)], { type: "application/json" }),
          );
        }
        if (variant === "peaks")
          return URL.createObjectURL(new Blob([levelBytes(Number(part.slice(1)))]));
        const sheet = await sheetCanvas().convertToBlob({ type: "image/jpeg", quality: 0.9 });
        return URL.createObjectURL(sheet);
      })();
      served.set(key, url);
    }
    return url;
  };
}
