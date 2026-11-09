// SPDX-FileCopyrightText: 2025-2026 OpenCut
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/*
 * Adapted from OpenCut classic (https://github.com/opencut-app/opencut-classic, commit cf5e79e9,
 * archived 2026-05-17), file apps/web/src/timeline/placement/overlap.ts. Ported for S7V-034 from the spike B1 copies.
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
 * s7video changes: MediaTime ticks -> integer frames; elements -> timeline items.
 */

export interface PlacementSpan {
  readonly start: number;
  readonly duration: number;
}

interface PlacedItem {
  readonly id: string;
  readonly start: number;
  readonly duration: number;
}

function wouldItemOverlap(
  items: ReadonlyArray<PlacedItem>,
  start: number,
  end: number,
  exclude: ReadonlySet<string>,
): boolean {
  return items.some((item) => {
    if (exclude.has(item.id)) return false;
    return start < item.start + item.duration && end > item.start;
  });
}

/** Whether every span fits on a row of `items` without overlapping one not in `exclude`. */
export function canPlaceSpansOnRow(
  items: ReadonlyArray<PlacedItem>,
  spans: ReadonlyArray<PlacementSpan>,
  exclude: ReadonlySet<string>,
): boolean {
  return spans.every(
    ({ start, duration }) => !wouldItemOverlap(items, start, start + duration, exclude),
  );
}
