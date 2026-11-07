// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { MediaFilmstripIndex, MediaPeaksIndex } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseFilmstripLevel,
  choosePeaksLevel,
  filmstripSlots,
  peakColumns,
  PEAKS_PER_TILE,
  peakTileRange,
  peakTilesFor,
  TileCache,
  tileAtFrame,
  tilePlacement,
} from "./mediaTiles";

// 30 minutes at 48 kHz, as the engine writes it.
const SAMPLES = 30 * 60 * 48_000;
const peaks: MediaPeaksIndex = {
  version: 1,
  audio: true,
  sampleRate: 48_000,
  durationSamples: SAMPLES,
  offsetSamples: 0,
  levels: [256, 1024, 4096, 16_384].map((samplesPerPeak) => ({
    samplesPerPeak,
    count: Math.ceil(SAMPLES / samplesPerPeak),
    file: `${samplesPerPeak}.f32`,
  })),
};

const level = (seconds: number, tiles: number) => ({
  level: `${seconds}s`,
  secondsPerTile: seconds,
  framesPerTile: seconds * 30,
  sheets: Array.from(
    { length: Math.ceil(tiles / 100) },
    (_, sheet) => `${seconds}s-${sheet + 1}.jpg`,
  ),
  frames: Array.from({ length: tiles }, (_, tile) => tile * seconds * 30),
});

const strip: MediaFilmstripIndex = {
  version: 1,
  video: true,
  rate: { num: 30, den: 1 },
  tileWidth: 160,
  tileHeight: 90,
  columns: 10,
  rows: 10,
  levels: [level(16, 113), level(4, 450), level(1, 1800)],
};

describe("waveform levels", () => {
  it("picks the coarsest level with at least one peak per pixel", () => {
    expect(choosePeaksLevel(peaks, 100_000)?.samplesPerPeak).toBe(16_384);
    expect(choosePeaksLevel(peaks, 16_384)?.samplesPerPeak).toBe(16_384);
    expect(choosePeaksLevel(peaks, 16_383)?.samplesPerPeak).toBe(4096);
    expect(choosePeaksLevel(peaks, 1500)?.samplesPerPeak).toBe(1024);
    // Zoomed in past the finest level, the finest is still drawn.
    expect(choosePeaksLevel(peaks, 10)?.samplesPerPeak).toBe(256);
  });

  it("fetches only the tiles under the visible window", () => {
    const finest = peaks.levels[0]!;
    const window = 1200 * 256;
    const tiles = peakTilesFor(finest, 200_000 * 256, 200_000 * 256 + window);
    expect(tiles).toEqual([97, 98]);
    expect(peakTilesFor(finest, -5000, 10)).toEqual([0]);
    expect(peakTilesFor(finest, SAMPLES + 1, SAMPLES + 100)).toEqual([]);
    expect(peakTileRange(finest, 1)).toEqual({
      header: `bytes=${PEAKS_PER_TILE * 8}-${PEAKS_PER_TILE * 16 - 1}`,
      peaks: PEAKS_PER_TILE,
      start: PEAKS_PER_TILE * 8,
    });
    const last = Math.floor((finest.count - 1) / PEAKS_PER_TILE);
    expect(peakTileRange(finest, last).peaks).toBe(finest.count - last * PEAKS_PER_TILE);
  });

  it("reduces peaks to pixel columns; silence is a flat line and unloaded tiles stay empty", () => {
    const finest = { samplesPerPeak: 256, count: 8, file: "256.f32" };
    const values: Array<readonly [number, number]> = [
      [-0.5, 0.5],
      [-1, 0.2],
      [0, 0],
      [0, 0],
      [-0.1, 0.9],
      [-0.3, 0.3],
    ];
    const columns = peakColumns(finest, (peak) => values[peak], 0, 8 * 256, 4);
    const expected = [-1, 0.5, 0, 0, -0.3, 0.9, Number.NaN, Number.NaN].map(Math.fround);
    expect([...columns]).toEqual(expected);
  });
});

describe("filmstrip levels", () => {
  it("picks the coarsest level that leaves no gap between slots", () => {
    // A whole 30-minute clip in 1,000 px: one slot spans far more than 16 s.
    expect(chooseFilmstripLevel(strip, 1000 / 54_000)?.level).toBe("16s");
    // 160 px per 4 s: the 4 s level fills every slot.
    expect(chooseFilmstripLevel(strip, 160 / 120)?.level).toBe("4s");
    expect(chooseFilmstripLevel(strip, 160 / 100)?.level).toBe("1s");
    expect(chooseFilmstripLevel(strip, 50)?.level).toBe("1s");
  });

  it("maps a tile to its sheet, row and column", () => {
    const finest = strip.levels[2]!;
    expect(tilePlacement(strip, finest, 0)).toEqual({ sheet: 1, part: "f1s-1", sx: 0, sy: 0 });
    expect(tilePlacement(strip, finest, 13)).toEqual({ sheet: 1, part: "f1s-1", sx: 480, sy: 90 });
    expect(tilePlacement(strip, finest, 1799)).toEqual({
      sheet: 18,
      part: "f1s-18",
      sx: 1440,
      sy: 810,
    });
  });

  it("finds the tile showing a frame by its real frame number", () => {
    const vfr = { ...strip.levels[2]!, frames: [0, 30, 61, 90, 122] };
    expect(tileAtFrame(vfr, 0)).toBe(0);
    expect(tileAtFrame(vfr, 60)).toBe(1);
    expect(tileAtFrame(vfr, 61)).toBe(2);
    expect(tileAtFrame(vfr, 10_000)).toBe(4);
  });

  it("lays slots edge to edge from the clip's left edge, steady while scrolling", () => {
    const finest = strip.levels[2]!;
    const window = { firstFrame: 0, endFrame: 300, width: 1600, slotWidth: 160 };
    const slots = filmstripSlots(strip, finest, window);
    expect(slots.map((slot) => [slot.x, slot.frame])).toEqual(
      Array.from({ length: 10 }, (_, index) => [index * 160, index * 30]),
    );
    // Scrolled by 15 frames (80 px): the same slots, 80 px to the left.
    const scrolled = filmstripSlots(strip, finest, {
      ...window,
      firstFrame: 15,
      endFrame: 315,
      anchorFrame: 0,
    });
    expect(scrolled[0]).toMatchObject({ x: -80, frame: 0 });
    expect(scrolled.at(-1)!.x).toBeLessThan(1600);
    expect(filmstripSlots(strip, finest, { ...window, width: 0 })).toEqual([]);
  });

  it("keeps the work bounded by the window, not the media length", () => {
    const finest = strip.levels[2]!;
    const slots = filmstripSlots(strip, finest, {
      firstFrame: 0,
      endFrame: 54_000,
      width: 1000,
      slotWidth: 160,
    });
    expect(slots.length).toBe(7);
  });
});

describe("TileCache", () => {
  it("evicts the least recently used entry and releases it", () => {
    const released: string[] = [];
    const cache = new TileCache<string>(2, (value) => released.push(value));
    cache.set("a", "A");
    cache.set("b", "B");
    cache.get("a");
    cache.set("c", "C");
    expect(released).toEqual(["B"]);
    expect(cache.get("a")).toBe("A");
    expect(cache.size).toBe(2);
  });
});
