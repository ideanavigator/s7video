// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Lane geometry as percentages (S7V-033) of a span box exactly `durationFrames × px-per-frame`
 * wide, whose width the controller writes. A zoom step then changes a few box widths and the
 * browser re-lays out the clips; no clip is restyled and React does not render.
 */

/** The x position of `frames` in a span of `durationFrames` (fractional for ruler ticks). */
export const spanX = (frames: number, durationFrames: number): string =>
  `${(frames / durationFrames) * 100}%`;

/** A clip's width: a pixel gap after it, never under one pixel. */
export const spanWidth = (frames: number, durationFrames: number): string =>
  `max(1px, calc(${(frames / durationFrames) * 100}% - 1px))`;

/** Marks an element the controller sizes to the span on every zoom step. */
export const SPAN_ATTRIBUTE = "data-timeline-span";
