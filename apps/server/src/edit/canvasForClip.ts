// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The edit's canvas (S7V-061): the first clip placed gives its own shape, and the user can ask
// for one of the common shapes later. Export renders at the canvas, so it decides the video's size.
import type { EditAspectRatio, EditCanvas, EditMediaProbe } from "@t3tools/contracts";

/** The export presets' long side; a 4K clip gets a 1080p canvas, as a reel does. */
const MAX_SIDE = 1920;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export const CANVAS_FOR_RATIO: Readonly<Record<EditAspectRatio, EditCanvas>> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "4:3": { width: 1440, height: 1080 },
};

/**
 * The canvas a clip's own shape gives, or undefined when its probe has no picture size. The probe
 * already holds the display size after rotation (MediaLibraryService), so a phone clip is tall.
 */
export function canvasForClip(probe: EditMediaProbe): EditCanvas | undefined {
  const { width, height } = probe;
  if (width === undefined || height === undefined) return undefined;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return {
    width: Math.min(MAX_SIDE, even(width * scale)),
    height: Math.min(MAX_SIDE, even(height * scale)),
  };
}
