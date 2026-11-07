// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The bottom of the Editor panel (S7V-033): a divider the viewer drags to size the timeline, and
 * the timeline itself. The height is remembered per viewer in local storage.
 */
import type { EditDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";
import { Timeline, TimelineSkeleton } from "./Timeline";

const HEIGHT_STORAGE_KEY = "editor-timeline-height:v1";
const MIN_HEIGHT_PX = 160;
const DEFAULT_HEIGHT_PX = 200;
/** The player and tabs keep at least this much of the panel. */
const MIN_ABOVE_PX = 240;
const KEY_STEP_PX = 16;

function storedHeight(): number {
  try {
    return getLocalStorageItem(HEIGHT_STORAGE_KEY, Schema.Finite) ?? DEFAULT_HEIGHT_PX;
  } catch {
    return DEFAULT_HEIGHT_PX;
  }
}

function storeHeight(height: number): void {
  try {
    setLocalStorageItem(HEIGHT_STORAGE_KEY, height, Schema.Finite);
  } catch {
    // Storage can be unavailable; the height still applies for this session.
  }
}

const maxHeightOf = (element: Element | null): number =>
  Math.max(MIN_HEIGHT_PX, (element?.parentElement?.clientHeight ?? 0) - MIN_ABOVE_PX);

export function TimelinePane(props: {
  readonly projectKey: string;
  readonly document: EditDocument | null;
  readonly playheadVisible: boolean;
  readonly initialFrame: number;
  readonly onSeek: (editFrame: number) => void;
}) {
  const [height, setHeight] = useState(storedHeight);
  const [drag, setDrag] = useState<{
    readonly startY: number;
    readonly startHeight: number;
  } | null>(null);
  const shown = Math.max(MIN_HEIGHT_PX, height);

  const resize = (target: Element, next: number) => {
    const clamped = Math.round(Math.max(MIN_HEIGHT_PX, Math.min(maxHeightOf(target), next)));
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
    resize(event.currentTarget, drag.startHeight + drag.startY - event.clientY);
  };
  const onPointerEnd = () => {
    if (drag === null) return;
    setDrag(null);
    storeHeight(shown);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    storeHeight(
      resize(event.currentTarget, shown + (event.key === "ArrowUp" ? KEY_STEP_PX : -KEY_STEP_PX)),
    );
  };

  return (
    <>
      <div
        role="separator"
        aria-label="Resize timeline"
        aria-orientation="horizontal"
        aria-valuenow={shown}
        aria-valuemin={MIN_HEIGHT_PX}
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
          />
        )}
      </section>
    </>
  );
}
