// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Paints one clip's waveform or filmstrip into a 2D context from whatever tiles are loaded, and
 * names the tiles it is still missing; both return how many were missing. Work is bounded by the
 * canvas width, not the media length.
 */
import type { MediaFilmstripIndex, MediaPeaksIndex } from "@t3tools/contracts";

import {
  chooseFilmstripLevel,
  choosePeaksLevel,
  filmstripSlots,
  peakColumns,
  peakTilesFor,
  PEAKS_PER_TILE,
} from "./mediaTiles";
import type { ClipView } from "./mediaTilesProtocol";

type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type PeaksLevel = MediaPeaksIndex["levels"][number];

export interface PeakTiles {
  readonly get: (level: PeaksLevel, tile: number) => Float32Array | undefined;
  readonly want: (level: PeaksLevel, tile: number) => void;
}

export interface Sheets {
  readonly get: (part: string) => CanvasImageSource | undefined;
  readonly want: (part: string) => void;
}

const prepare = (context: Context2D, view: ClipView) => {
  const width = Math.max(1, Math.round(view.width * view.pixelRatio));
  const height = Math.max(1, Math.round(view.height * view.pixelRatio));
  if (context.canvas.width !== width) context.canvas.width = width;
  if (context.canvas.height !== height) context.canvas.height = height;
  context.clearRect(0, 0, width, height);
  return { width, height };
};

export const drawWaveform = (
  context: Context2D,
  view: ClipView,
  index: MediaPeaksIndex,
  tiles: PeakTiles,
) => {
  const { width, height } = prepare(context, view);
  if (!index.audio || view.endFrame <= view.firstFrame) return 0;
  const toSample = (frame: number) =>
    (frame * view.fps.den * index.sampleRate) / view.fps.num - (index.offsetSamples ?? 0);
  const firstSample = toSample(view.firstFrame);
  const endSample = toSample(view.endFrame);
  const level = choosePeaksLevel(index, (endSample - firstSample) / width);
  if (level === undefined) return 0;
  let missing = 0;
  for (const tile of peakTilesFor(level, firstSample, endSample)) {
    if (tiles.get(level, tile) !== undefined) continue;
    missing += 1;
    tiles.want(level, tile);
  }
  const peakAt = (peak: number) => {
    const tile = tiles.get(level, Math.floor(peak / PEAKS_PER_TILE));
    const at = (peak % PEAKS_PER_TILE) * 2;
    return tile === undefined || at + 1 >= tile.length
      ? undefined
      : ([tile[at]!, tile[at + 1]!] as const);
  };
  const values = peakColumns(level, peakAt, firstSample, endSample, width);
  const middle = height / 2;
  context.fillStyle = view.color;
  for (let column = 0; column < width; column += 1) {
    const low = values[column * 2]!;
    const high = values[column * 2 + 1]!;
    if (Number.isNaN(low)) continue;
    const top = middle - Math.min(1, high) * middle;
    const bottom = middle - Math.max(-1, low) * middle;
    // A flat line where it is silent, never a gap.
    context.fillRect(column, top, 1, Math.max(1, bottom - top));
  }
  return missing;
};

export const drawFilmstrip = (
  context: Context2D,
  view: ClipView,
  index: MediaFilmstripIndex,
  sheets: Sheets,
) => {
  const { height } = prepare(context, view);
  if (!index.video || view.endFrame <= view.firstFrame) return 0;
  // Tile frames are at the media's own rate; the view's may be the edit's (25 fps media in a 30 fps edit).
  const toMediaFrame = (frame: number) =>
    (frame * index.rate.num * view.fps.den) / (index.rate.den * view.fps.num);
  const window = {
    firstFrame: toMediaFrame(view.firstFrame),
    endFrame: toMediaFrame(view.endFrame),
    anchorFrame: toMediaFrame(view.anchorFrame),
    width: view.width,
    slotWidth: (index.tileWidth * view.height) / index.tileHeight,
  };
  const pixelsPerFrame = window.width / (window.endFrame - window.firstFrame);
  const level = chooseFilmstripLevel(index, pixelsPerFrame, window.slotWidth);
  if (level === undefined) return 0;
  const ratio = view.pixelRatio;
  const slotWidth = window.slotWidth;
  let missing = 0;
  for (const slot of filmstripSlots(index, level, window)) {
    const sheet = sheets.get(slot.part);
    if (sheet === undefined) {
      missing += 1;
      sheets.want(slot.part);
      continue;
    }
    context.drawImage(
      sheet,
      slot.sx,
      slot.sy,
      index.tileWidth,
      index.tileHeight,
      Math.round(slot.x * ratio),
      0,
      Math.ceil(slotWidth * ratio),
      height,
    );
  }
  return missing;
};
