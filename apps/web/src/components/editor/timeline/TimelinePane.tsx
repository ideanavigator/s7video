// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The bottom of the Editor panel (S7V-033): a divider the viewer drags to size the timeline, and
 * the timeline itself. The height is remembered per viewer in local storage.
 */
import type { EditDocument, MediaAsset, ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState, type KeyboardEvent, type PointerEvent } from "react";

import type { PlaybackPlan } from "../../../editor/editPlayback";
import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";
import { observeResize } from "../../../lib/observeResize";
import { Timeline, TimelineSkeleton } from "./Timeline";
import {
  TIMELINE_RULER_HEIGHT_PX,
  TIMELINE_TRACK_GAP_PX,
  TIMELINE_TRACK_HEIGHTS_PX,
} from "./vendor/opencut/theme";

const HEIGHT_STORAGE_KEY = "editor-timeline-height:v1";
/** A classic (always shown) horizontal scrollbar, as with a mouse attached. */
const SCROLLBAR_PX = 16;
const BORDER_PX = 2;
/** The ruler and the five rows, with their gaps: what the timeline shows without scrolling. */
const FIVE_ROWS_PX =
  TIMELINE_RULER_HEIGHT_PX +
  (["overlay", "video", "caption", "sfx", "music"] as const).reduce(
    (total, kind) => total + TIMELINE_TRACK_HEIGHTS_PX[kind] + TIMELINE_TRACK_GAP_PX,
    TIMELINE_TRACK_GAP_PX,
  );
/** Never shorter than the five rows plus a scrollbar, so no row is cut off. */
const MIN_TIMELINE_HEIGHT_PX = FIVE_ROWS_PX + SCROLLBAR_PX + BORDER_PX;
const DEFAULT_TIMELINE_HEIGHT_PX = MIN_TIMELINE_HEIGHT_PX + 16;
/** The player and tabs keep at least this much of the panel. */
const MIN_ABOVE_PX = 240;
const KEY_STEP_PX = 16;

function storedHeight(): number {
  try {
    return getLocalStorageItem(HEIGHT_STORAGE_KEY, Schema.Finite) ?? DEFAULT_TIMELINE_HEIGHT_PX;
  } catch {
    return DEFAULT_TIMELINE_HEIGHT_PX;
  }
}

function storeHeight(height: number): void {
  try {
    setLocalStorageItem(HEIGHT_STORAGE_KEY, height, Schema.Finite);
  } catch {
    // Storage can be unavailable; the height still applies for this session.
  }
}

const maxHeightIn = (panelHeight: number): number =>
  Math.max(MIN_TIMELINE_HEIGHT_PX, panelHeight - MIN_ABOVE_PX);

export function TimelinePane(props: {
  readonly projectKey: string;
  readonly document: EditDocument | null;
  readonly playheadVisible: boolean;
  readonly initialFrame: number;
  readonly onSeek: (editFrame: number) => void;
  readonly plan: PlaybackPlan | null;
  readonly projectRef: ScopedProjectRef;
  readonly mediaById: ReadonlyMap<string, MediaAsset>;
}) {
  const [height, setHeight] = useState(storedHeight);
  const [drag, setDrag] = useState<{
    readonly startY: number;
    readonly startHeight: number;
  } | null>(null);
  // The panel's height, so a stored height re-clamps when the window shrinks and the 16:9
  // player keeps its room; unknown (no upper clamp) until measured.
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const observePanel = (element: HTMLElement | null) => {
    const panel = element?.parentElement;
    if (panel === null || panel === undefined) return undefined;
    return observeResize(panel, () => setPanelHeight(panel.clientHeight));
  };
  const maxHeight = panelHeight === null ? Number.POSITIVE_INFINITY : maxHeightIn(panelHeight);
  const shown = Math.round(Math.max(MIN_TIMELINE_HEIGHT_PX, Math.min(maxHeight, height)));

  const resize = (next: number) => {
    const clamped = Math.round(Math.max(MIN_TIMELINE_HEIGHT_PX, Math.min(maxHeight, next)));
    setHeight(clamped);
    return clamped;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ startY: event.clientY, startHeight: shown });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    resize(drag.startHeight + drag.startY - event.clientY);
  };
  const onPointerEnd = () => {
    if (drag === null) return;
    setDrag(null);
    storeHeight(shown);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    storeHeight(resize(shown + (event.key === "ArrowUp" ? KEY_STEP_PX : -KEY_STEP_PX)));
  };

  return (
    <>
      <div
        role="separator"
        aria-label="Resize timeline"
        aria-orientation="horizontal"
        aria-valuenow={shown}
        aria-valuemin={MIN_TIMELINE_HEIGHT_PX}
        tabIndex={0}
        data-dragging={drag !== null}
        className="group relative -my-1 h-2 shrink-0 cursor-row-resize touch-none outline-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary group-data-[dragging=true]:bg-primary/60"
        />
      </div>
      <section
        ref={observePanel}
        aria-label="Timeline"
        data-testid="editor-timeline"
        className="min-h-0 shrink-0 overflow-hidden rounded-md border"
        style={{ height: shown }}
      >
        {props.document === null ? (
          <TimelineSkeleton />
        ) : (
          <Timeline
            key={props.projectKey}
            projectKey={props.projectKey}
            document={props.document}
            playheadVisible={props.playheadVisible}
            initialFrame={props.initialFrame}
            onSeek={props.onSeek}
            plan={props.plan}
            projectRef={props.projectRef}
            mediaById={props.mediaById}
          />
        )}
      </section>
    </>
  );
}
