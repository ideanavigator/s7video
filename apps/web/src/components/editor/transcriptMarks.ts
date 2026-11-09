// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Transcript tab's marks, set outside React so nothing re-renders per frame (S7V-030):
 * `data-current` (the word playing), `data-active` (the keyboard's word) and the text-edit
 * selection (`data-selected`, S7V-038). Rows mounted later take their marks in `applyToRow`.
 */
import type { LegendListRef } from "@legendapp/list/react";

import type { PlaybackSegment } from "../../editor/editPlayback";
import {
  rowOfWord,
  type TranscriptModel,
  type TranscriptRow,
  wordAtTimelineFrame,
} from "../../editor/transcriptModel";

/** After the user scrolls the list, playback leaves it alone for this long. */
export const USER_SCROLL_HOLD_MS = 3_000;

export interface TranscriptMarks {
  readonly attachRoot: (element: HTMLElement | null) => void;
  readonly attachList: (list: LegendListRef | null) => void;
  /** A new model or edit. Re-marks the word at the last frame without scrolling. */
  readonly update: (model: TranscriptModel, segments: ReadonlyArray<PlaybackSegment>) => void;
  /** The player's edit frame on screen. */
  readonly showFrame: (timelineFrame: number) => void;
  readonly setActive: (index: number) => void;
  readonly active: () => number;
  readonly current: () => number;
  readonly applyToRow: (row: TranscriptRow) => void;
  /** Selects words `anchor..focus`, in either order. */
  readonly setSelection: (anchor: number, focus: number) => void;
  readonly clearSelection: () => void;
  /** The selection as the user made it: `anchor` stays put while `focus` moves. */
  readonly selection: () => { readonly anchor: number; readonly focus: number } | null;
  readonly noteUserScroll: () => void;
  readonly wordId: (index: number) => string;
}

export function createTranscriptMarks(
  idPrefix: string,
  now: () => number = () => performance.now(),
): TranscriptMarks {
  let model: TranscriptModel | null = null;
  let segments: ReadonlyArray<PlaybackSegment> = [];
  let root: HTMLElement | null = null;
  let list: LegendListRef | null = null;
  let current = -1;
  let active = -1;
  let lastFrame: number | null = null;
  let userScrolledAt = Number.NEGATIVE_INFINITY;
  let selection: { anchor: number; focus: number } | null = null;

  const wordId = (index: number) => `${idPrefix}${index}`;
  const wordElement = (index: number) =>
    index < 0 ? null : document.getElementById(wordId(index));
  const move = (attribute: string, from: number, to: number) => {
    wordElement(from)?.removeAttribute(attribute);
    wordElement(to)?.setAttribute(attribute, "");
  };
  const pointRootAt = (index: number) => {
    if (root === null) return;
    if (index !== -1 && wordElement(index) !== null) {
      root.setAttribute("aria-activedescendant", wordId(index));
    } else root.removeAttribute("aria-activedescendant");
  };

  const selectedRange = () =>
    selection === null
      ? null
      : {
          first: Math.min(selection.anchor, selection.focus),
          last: Math.max(selection.anchor, selection.focus),
        };
  const markSelected = (index: number, on: boolean) => {
    const element = wordElement(index);
    if (element === null) return;
    if (on) element.setAttribute("data-selected", "");
    else element.removeAttribute("data-selected");
    element.setAttribute("aria-selected", on ? "true" : "false");
  };
  /** Touches only the words whose state changes. */
  const select = (next: { anchor: number; focus: number } | null) => {
    const before = selectedRange();
    selection = next;
    const after = selectedRange();
    const inside = (range: typeof after, index: number) =>
      range !== null && index >= range.first && index <= range.last;
    for (const range of [before, after]) {
      if (range === null) continue;
      for (let index = range.first; index <= range.last; index += 1) {
        const on = inside(after, index);
        if (on !== inside(before, index)) markSelected(index, on);
      }
    }
  };

  /** Scrolls word `index` into view when it is outside the list's viewport. */
  const reveal = (index: number) => {
    const scroller = list?.getScrollableNode() ?? null;
    const element = wordElement(index);
    if (scroller !== null && element !== null) {
      const view = scroller.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      if (box.top >= view.top && box.bottom <= view.bottom) return;
      scroller.scrollTop += box.top - view.top - view.height / 3;
      return;
    }
    if (model !== null && list !== null) {
      void list.scrollToIndex({
        index: rowOfWord(model, index),
        viewPosition: 0.3,
        animated: false,
      });
    }
  };

  const mark = (next: number, follow: boolean) => {
    if (next === current) return;
    move("data-current", current, next);
    current = next;
    if (follow && next !== -1 && now() - userScrolledAt > USER_SCROLL_HOLD_MS) {
      reveal(next);
    }
  };

  const markAt = (frame: number, follow: boolean) => {
    lastFrame = frame;
    mark(model === null ? -1 : wordAtTimelineFrame(model, segments, frame), follow);
  };

  return {
    wordId,
    attachRoot: (element) => {
      root = element;
    },
    attachList: (next) => {
      list = next;
    },
    update: (nextModel, nextSegments) => {
      if (model !== null && model.words.length !== nextModel.words.length) {
        select(null);
        mark(-1, false);
        move("data-active", active, -1);
        active = -1;
        pointRootAt(-1);
      }
      model = nextModel;
      segments = nextSegments;
      if (lastFrame !== null) markAt(lastFrame, false);
    },
    showFrame: (frame) => markAt(frame, true),
    setActive: (index) => {
      move("data-active", active, index);
      active = index;
      userScrolledAt = now();
      reveal(index);
      pointRootAt(index);
    },
    active: () => active,
    current: () => current,
    applyToRow: (row) => {
      if (current >= row.first && current < row.end)
        wordElement(current)?.setAttribute("data-current", "");
      const range = selectedRange();
      if (range !== null) {
        const from = Math.max(range.first, row.first);
        const to = Math.min(range.last, row.end - 1);
        for (let index = from; index <= to; index += 1) markSelected(index, true);
      }
      if (active >= row.first && active < row.end) {
        wordElement(active)?.setAttribute("data-active", "");
        pointRootAt(active);
      }
    },
    noteUserScroll: () => {
      userScrolledAt = now();
    },
    setSelection: (anchor, focus) => select({ anchor, focus }),
    clearSelection: () => select(null),
    selection: () => selection,
  };
}
