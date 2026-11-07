// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The timeline's media data (S7V-035): which waveform level and filmstrip level to draw at a zoom,
 * and which tiles of them fall in the visible window. Pure and bounded by the window, never by
 * the media's length, so it runs in the drawing worker and in tests alike.
 */
import type { MediaFilmstripIndex, MediaPeaksIndex } from "@t3tools/contracts";

/** Peaks fetched and cached together: 2,048 pairs, 16 KiB of one level file. */
export const PEAKS_PER_TILE = 2048;
const BYTES_PER_PEAK = 8;

type PeaksLevel = MediaPeaksIndex["levels"][number];
type FilmstripLevel = MediaFilmstripIndex["levels"][number];

/** The coarsest level that still has at least one peak per pixel; the finest when zoomed past it. */
export const choosePeaksLevel = (
  index: MediaPeaksIndex,
  samplesPerPixel: number,
): PeaksLevel | undefined => {
  const levels = index.levels.toSorted((a, b) => a.samplesPerPeak - b.samplesPerPeak);
  return levels.findLast((level) => level.samplesPerPeak <= samplesPerPixel) ?? levels[0];
};

/** The `part` name of a peaks level (`p1024`). */
export const peaksPart = (level: PeaksLevel) => `p${level.samplesPerPeak}`;

/** Tiles of `level` covering samples `[firstSample, endSample)`, clamped to the level. */
export const peakTilesFor = (level: PeaksLevel, firstSample: number, endSample: number) => {
  const first = Math.max(0, Math.floor(firstSample / level.samplesPerPeak));
  const end = Math.min(level.count, Math.ceil(endSample / level.samplesPerPeak));
  if (end <= first) return [];
  const tiles: number[] = [];
  for (let tile = Math.floor(first / PEAKS_PER_TILE); tile * PEAKS_PER_TILE < end; tile += 1) {
    tiles.push(tile);
  }
  return tiles;
};

/** The HTTP `Range` of one tile of a level file, and how many pairs it holds. */
export const peakTileRange = (level: PeaksLevel, tile: number) => {
  const firstPeak = tile * PEAKS_PER_TILE;
  const peaks = Math.max(0, Math.min(PEAKS_PER_TILE, level.count - firstPeak));
  const start = firstPeak * BYTES_PER_PEAK;
  return { header: `bytes=${start}-${start + peaks * BYTES_PER_PEAK - 1}`, peaks, start };
};

/**
 * Per-pixel `[min, max]` for `width` columns spanning samples `[firstSample, endSample)`, from
 * peaks `peakAt(i)`. Columns with no peak under them are NaN, so silence and "no data" differ.
 */
export const peakColumns = (
  level: PeaksLevel,
  peakAt: (peak: number) => readonly [number, number] | undefined,
  firstSample: number,
  endSample: number,
  width: number,
) => {
  const out = new Float32Array(width * 2).fill(Number.NaN);
  if (width <= 0 || endSample <= firstSample) return out;
  const samplesPerColumn = (endSample - firstSample) / width;
  for (let column = 0; column < width; column += 1) {
    const from = firstSample + column * samplesPerColumn;
    const first = Math.max(0, Math.floor(from / level.samplesPerPeak));
    const end = Math.min(
      level.count,
      Math.max(first + 1, Math.ceil((from + samplesPerColumn) / level.samplesPerPeak)),
    );
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let peak = first; peak < end; peak += 1) {
      const pair = peakAt(peak);
      if (pair === undefined) continue;
      if (pair[0] < low) low = pair[0];
      if (pair[1] > high) high = pair[1];
    }
    if (low <= high) {
      out[column * 2] = low;
      out[column * 2 + 1] = high;
    }
  }
  return out;
};

/**
 * The coarsest filmstrip level whose tiles, at `pixelsPerFrame`, sit no further apart than one
 * slot (`slotWidth` px, a tile drawn at the strip's height), so no slot repeats a tile while a
 * finer one exists; the finest when zoomed in past every level.
 */
export const chooseFilmstripLevel = (
  index: MediaFilmstripIndex,
  pixelsPerFrame: number,
  slotWidth: number = index.tileWidth,
): FilmstripLevel | undefined => {
  const levels = index.levels.toSorted((a, b) => b.framesPerTile - a.framesPerTile);
  return levels.find((level) => level.framesPerTile * pixelsPerFrame <= slotWidth) ?? levels.at(-1);
};

/** The last tile of `level` whose frame is at or before `frame` (binary search over `frames`). */
export const tileAtFrame = (level: FilmstripLevel, frame: number) => {
  let low = 0;
  let high = level.frames.length - 1;
  if (high < 0) return -1;
  if (frame < level.frames[0]!) return 0;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (level.frames[middle]! <= frame) low = middle;
    else high = middle - 1;
  }
  return low;
};

/** Where tile `tile` sits: its sheet's `part` name and its source rectangle on that sheet. */
export const tilePlacement = (index: MediaFilmstripIndex, level: FilmstripLevel, tile: number) => {
  const perSheet = index.columns * index.rows;
  const within = tile % perSheet;
  const sheet = Math.floor(tile / perSheet) + 1;
  return {
    sheet,
    part: `f${level.level}-${sheet}`,
    sx: (within % index.columns) * index.tileWidth,
    sy: Math.floor(within / index.columns) * index.tileHeight,
  };
};

export interface FilmstripSlot {
  /** Left edge in the canvas, in CSS pixels; slots are one tile wide, edge to edge. */
  readonly x: number;
  readonly tile: number;
  readonly frame: number;
  readonly part: string;
  readonly sx: number;
  readonly sy: number;
}

/**
 * Slots `slotWidth` px wide across `width` px showing frames `[firstFrame, endFrame)`, edge to edge
 * from `anchorFrame` (the clip's left edge), so they stay put while the window scrolls; each
 * shows the nearest tile at or before the frame under its left edge.
 */
export const filmstripSlots = (
  index: MediaFilmstripIndex,
  level: FilmstripLevel,
  window: {
    readonly firstFrame: number;
    readonly endFrame: number;
    readonly width: number;
    readonly anchorFrame?: number;
    readonly slotWidth?: number;
  },
): FilmstripSlot[] => {
  const { firstFrame, endFrame, width } = window;
  const anchorFrame = window.anchorFrame ?? firstFrame;
  const slotWidth = window.slotWidth ?? index.tileWidth;
  if (width <= 0 || endFrame <= firstFrame || level.frames.length === 0 || slotWidth <= 0) {
    return [];
  }
  const pixelsPerFrame = width / (endFrame - firstFrame);
  const offset = (firstFrame - anchorFrame) * pixelsPerFrame;
  const slots: FilmstripSlot[] = [];
  for (let slot = Math.floor(offset / slotWidth); slot * slotWidth - offset < width; slot += 1) {
    const frame = anchorFrame + (slot * slotWidth) / pixelsPerFrame;
    const tile = tileAtFrame(level, frame);
    if (tile < 0) break;
    slots.push({
      x: slot * slotWidth - offset,
      tile,
      frame: level.frames[tile]!,
      ...tilePlacement(index, level, tile),
    });
  }
  return slots;
};

/** A small least-recently-used map; `onEvict` releases what a value holds (an `ImageBitmap`). */
export class TileCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(
    private readonly limit: number,
    private readonly onEvict: (value: V) => void = () => {},
  ) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const [oldest, evicted] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.onEvict(evicted);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
