// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), files apps/web/src/timeline/components/theme.ts and components/layout.ts. Copied for S7V-033 from the spike B1 copies.
 *
 * Copyright 2025-2026 OpenCut
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * s7video changes: track types renamed to edit.json kinds; colours are theme tokens
 * (CSS variables) instead of hex, so a white-label theme recolours the tracks; heights tuned to fit
 * five rows in the Editor panel; ruler height and label column width kept.
 */

import type { EditTrackKind } from "@t3tools/contracts";

// OpenCut: text #5DBAA0, audio #8F5DBA, graphic #BA5D7A, effect #5d93ba. s7video takes the colours
// from the brand theme (`track.*` in themes/*.json, set as CSS variables by themePalette.ts).
export const TIMELINE_TRACK_COLOR: Record<EditTrackKind, string> = {
  video: "var(--track-video)",
  caption: "var(--track-text)",
  sfx: "var(--track-sfx)",
  music: "var(--track-music)",
  overlay: "var(--track-overlay)",
};

/** The CSS variable behind each track colour, for canvas drawing (which needs a resolved colour). */
export const TIMELINE_TRACK_COLOR_VARIABLE: Record<EditTrackKind, string> = {
  video: "--track-video",
  caption: "--track-text",
  sfx: "--track-sfx",
  music: "--track-music",
  overlay: "--track-overlay",
};

// OpenCut: video 65, text 25, audio 50, effect 30. Shorter here so the five rows fit the panel.
export const TIMELINE_TRACK_HEIGHTS_PX: Record<EditTrackKind, number> = {
  video: 48,
  caption: 24,
  sfx: 28,
  music: 36,
  overlay: 24,
};
export const TIMELINE_TRACK_GAP_PX = 4;
export const TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX = 112;
export const TIMELINE_RULER_HEIGHT_PX = 22;
