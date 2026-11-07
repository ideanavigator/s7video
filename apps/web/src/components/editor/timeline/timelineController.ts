// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The timeline's interaction logic (S7V-033), outside React so React Compiler compiles the
 * components (spike B1 bailed out on a component holding it): native scroll, zoom, click to seek,
 * keys and the playhead. React renders its snapshot only on a zoom or a bucket crossing.
 */
import { observeResize } from "../../../lib/observeResize";
import { createPlayheadDriver, type PlayheadDriver } from "./playheadDriver";
import {
  bucketOf,
  bucketWidthPx,
  clampZoom,
  contentWidthPx,
  frameAtPx,
  zoomAround,
  zoomFactorOfWheel,
  zoomLimits,
} from "./timelineViewport";
import { nextDetailScale } from "./lod";
import { TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX } from "./vendor/opencut/theme";

export interface TimelineSnapshot {
  readonly pxPerFrame: number;
  /** The scale LOD decides at (`lod.ts`); lags `pxPerFrame` inside the hysteresis band. */
  readonly detailScale: number;
  readonly bucket: number;
  readonly bucketPx: number;
  /** Visible lane width: the scroll container minus the sticky track labels. */
  readonly laneWidthPx: number;
  readonly contentWidthPx: number;
  readonly durationFrames: number;
}

export interface TimelineController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TimelineSnapshot;
  /** Ref callbacks; each returns its cleanup. */
  readonly attachScroller: (element: HTMLDivElement | null) => (() => void) | undefined;
  readonly attachContent: (element: HTMLDivElement | null) => void;
  readonly attachPlayhead: (element: HTMLDivElement | null) => void;
  readonly attachSlider: (element: HTMLDivElement | null) => void;
  readonly setDuration: (durationFrames: number) => void;
  readonly setPlayheadVisible: (visible: boolean, frame: number) => void;
  readonly setSeekHandler: (seek: (editFrame: number) => void) => void;
  readonly setFrameFormatter: (format: (editFrame: number) => string) => void;
  /** Zooms by `factor` around lane pixel `anchorX` (from the left of the visible lanes). */
  readonly zoomBy: (factor: number, anchorX: number) => void;
  readonly seekToFrame: (editFrame: number) => void;
  readonly playheadFrame: () => number;
}

export interface TimelineControllerOptions {
  readonly projectKey: string;
  readonly durationFrames: number;
  /** Frames in one second, rounded, for shift + arrow. */
  readonly framesPerSecond: number;
  readonly initialFrame: number;
}

const DEFAULT_LANE_WIDTH_PX = 800;
const KEY_ZOOM_FACTOR = 1.5;
/** A wheel in lines or pages (Firefox, some mice) as pixels. */
const WHEEL_LINE_PX = 16;
/** Where the playhead lands after following playback off the right edge. */
const FOLLOW_MARGIN_FRACTION = 0.1;

export function createTimelineController(options: TimelineControllerOptions): TimelineController {
  const listeners = new Set<() => void>();
  let scroller: HTMLDivElement | null = null;
  let content: HTMLDivElement | null = null;
  let slider: HTMLDivElement | null = null;
  let seekHandler: (editFrame: number) => void = () => {};
  let formatFrame: (editFrame: number) => string = String;
  let laneWidth = DEFAULT_LANE_WIDTH_PX;
  let durationFrames = options.durationFrames;
  let limits = zoomLimits(durationFrames, laneWidth);
  /** Fit to the whole edit until the user zooms; a fitted edit stays fitted as it grows. */
  let fitted = true;
  let pxPerFrame = limits.min;
  let detailScale = pxPerFrame;
  let bucketPx = bucketWidthPx(laneWidth);
  let bucket = 0;
  let snapshot = makeSnapshot();
  let lastPlayheadInView = true;

  function makeSnapshot(): TimelineSnapshot {
    return {
      pxPerFrame,
      detailScale,
      bucket,
      bucketPx,
      laneWidthPx: laneWidth,
      contentWidthPx: contentWidthPx(durationFrames, pxPerFrame, laneWidth),
      durationFrames,
    };
  }

  const emit = () => {
    const next = makeSnapshot();
    if (
      next.pxPerFrame === snapshot.pxPerFrame &&
      next.detailScale === snapshot.detailScale &&
      next.bucket === snapshot.bucket &&
      next.bucketPx === snapshot.bucketPx &&
      next.laneWidthPx === snapshot.laneWidthPx &&
      next.contentWidthPx === snapshot.contentWidthPx &&
      next.durationFrames === snapshot.durationFrames
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const lastFrame = () => Math.max(0, durationFrames - 1);

  const writeSlider = (frame: number) => {
    if (slider === null) return;
    slider.setAttribute("aria-valuenow", String(frame));
    slider.setAttribute("aria-valuemax", String(lastFrame()));
    slider.setAttribute("aria-valuetext", formatFrame(frame));
  };

  /** While playing, a playhead that runs off the right edge pages the view; a scrolled-away view stays. */
  const follow = (frame: number) => {
    if (scroller === null) return;
    const x = frame * pxPerFrame;
    const left = scroller.scrollLeft;
    const inView = x >= left && x <= left + laneWidth;
    if (!inView && lastPlayheadInView && x > left) {
      scroller.scrollLeft = Math.max(0, x - laneWidth * FOLLOW_MARGIN_FRACTION);
      lastPlayheadInView = true;
      return;
    }
    lastPlayheadInView = inView;
  };

  const playhead: PlayheadDriver = createPlayheadDriver({
    projectKey: options.projectKey,
    initialFrame: options.initialFrame,
    pxPerFrame,
    onFrame: (frame) => {
      writeSlider(frame);
      follow(frame);
    },
  });

  const applyZoom = (next: number, anchorX: number) => {
    const clamped = clampZoom(next, limits);
    if (clamped === pxPerFrame) return;
    fitted = clamped === limits.min;
    const left = scroller?.scrollLeft ?? 0;
    const result = zoomAround(left, pxPerFrame, clamped, anchorX);
    pxPerFrame = result.pxPerFrame;
    detailScale = nextDetailScale(detailScale, pxPerFrame);
    // Widen the content before scrolling, so the browser does not clamp the anchored position.
    if (content !== null) {
      content.style.width = `${contentWidthPx(durationFrames, pxPerFrame, laneWidth) + TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX}px`;
    }
    if (scroller !== null) scroller.scrollLeft = result.scrollLeft;
    bucket = bucketOf(scroller?.scrollLeft ?? result.scrollLeft, bucketPx);
    playhead.setPxPerFrame(pxPerFrame);
    emit();
  };

  const relimit = () => {
    limits = zoomLimits(durationFrames, laneWidth);
    const next = fitted ? limits.min : clampZoom(pxPerFrame, limits);
    if (next !== pxPerFrame) {
      pxPerFrame = next;
      detailScale = nextDetailScale(detailScale, pxPerFrame);
      playhead.setPxPerFrame(pxPerFrame);
    }
    bucketPx = bucketWidthPx(laneWidth);
    bucket = bucketOf(scroller?.scrollLeft ?? 0, bucketPx);
  };

  const laneXOfClient = (clientX: number): number | null => {
    if (scroller === null) return null;
    const x =
      clientX - scroller.getBoundingClientRect().left - TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX;
    return x < 0 ? null : x;
  };

  const seekToFrame = (editFrame: number) => {
    const frame = Math.max(0, Math.min(lastFrame(), Math.trunc(editFrame)));
    playhead.place(frame);
    seekHandler(frame);
  };

  const onScroll = () => {
    if (scroller === null) return;
    const next = bucketOf(scroller.scrollLeft, bucketPx);
    if (next === bucket) return;
    bucket = next;
    emit();
  };

  let pendingWheel = 0;
  let wheelAnchor = 0;
  let wheelFrame = 0;
  const onWheel = (event: WheelEvent) => {
    if (scroller === null) return;
    const scale = event.deltaMode === 0 ? 1 : WHEEL_LINE_PX;
    if (!(event.ctrlKey || event.metaKey)) {
      const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
      const tracksOverflow = scroller.scrollHeight > scroller.clientHeight + 1;
      // A mouse wheel scrolls the edit sideways, as in CapCut, unless the tracks need it.
      if (vertical && !event.shiftKey && !tracksOverflow) {
        event.preventDefault();
        scroller.scrollLeft += event.deltaY * scale;
      }
      return;
    }
    // Trackpad pinch arrives as ctrl + wheel. One zoom step per frame however many events come.
    event.preventDefault();
    pendingWheel += event.deltaY * scale;
    wheelAnchor = laneXOfClient(event.clientX) ?? 0;
    if (wheelFrame !== 0) return;
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      const delta = pendingWheel;
      pendingWheel = 0;
      applyZoom(pxPerFrame * zoomFactorOfWheel(delta), wheelAnchor);
    });
  };

  let scrubbing: number | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || scroller === null) return;
    const x = laneXOfClient(event.clientX);
    if (x === null) return;
    seekToFrame(frameAtPx(scroller.scrollLeft + x, pxPerFrame, lastFrame()));
    const onRuler =
      event.target instanceof Element && event.target.closest("[data-timeline-ruler]");
    if (onRuler) {
      scrubbing = event.pointerId;
      scroller.setPointerCapture?.(event.pointerId);
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (scrubbing !== event.pointerId || scroller === null) return;
    const x = laneXOfClient(event.clientX) ?? 0;
    seekToFrame(frameAtPx(scroller.scrollLeft + x, pxPerFrame, lastFrame()));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (scrubbing === event.pointerId) scrubbing = null;
  };

  const playheadAnchorX = () => {
    const x = playhead.frame() * pxPerFrame - (scroller?.scrollLeft ?? 0);
    return x >= 0 && x <= laneWidth ? x : laneWidth / 2;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? options.framesPerSecond : 1;
      seekToFrame(playhead.frame() + (event.key === "ArrowLeft" ? -step : step));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyZoom(pxPerFrame * KEY_ZOOM_FACTOR, playheadAnchorX());
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      applyZoom(pxPerFrame / KEY_ZOOM_FACTOR, playheadAnchorX());
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      seekToFrame(event.key === "Home" ? 0 : lastFrame());
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    attachScroller: (element) => {
      scroller = element;
      if (element === null) return undefined;
      laneWidth = Math.max(1, element.clientWidth - TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX);
      relimit();
      emit();
      const disconnect = playhead.connect();
      element.addEventListener("scroll", onScroll, { passive: true });
      element.addEventListener("wheel", onWheel, { passive: false });
      element.addEventListener("pointerdown", onPointerDown);
      element.addEventListener("pointermove", onPointerMove);
      element.addEventListener("pointerup", onPointerUp);
      element.addEventListener("pointercancel", onPointerUp);
      element.addEventListener("keydown", onKeyDown);
      const stopResize = observeResize(element, () => {
        const next = Math.max(1, element.clientWidth - TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX);
        if (next === laneWidth) return;
        laneWidth = next;
        relimit();
        emit();
      });
      return () => {
        disconnect();
        stopResize();
        cancelAnimationFrame(wheelFrame);
        wheelFrame = 0;
        element.removeEventListener("scroll", onScroll);
        element.removeEventListener("wheel", onWheel);
        element.removeEventListener("pointerdown", onPointerDown);
        element.removeEventListener("pointermove", onPointerMove);
        element.removeEventListener("pointerup", onPointerUp);
        element.removeEventListener("pointercancel", onPointerUp);
        element.removeEventListener("keydown", onKeyDown);
        if (scroller === element) scroller = null;
      };
    },
    attachContent: (element) => {
      content = element;
    },
    attachPlayhead: (element) => playhead.attach(element),
    attachSlider: (element) => {
      slider = element;
      writeSlider(playhead.frame());
    },
    setDuration: (next) => {
      if (next === durationFrames) return;
      durationFrames = next;
      relimit();
      writeSlider(playhead.frame());
      emit();
    },
    setPlayheadVisible: (visible, frame) => {
      playhead.setVisible(visible);
      if (visible) playhead.place(frame);
    },
    setSeekHandler: (seek) => {
      seekHandler = seek;
    },
    setFrameFormatter: (format) => {
      formatFrame = format;
      writeSlider(playhead.frame());
    },
    zoomBy: (factor, anchorX) => applyZoom(pxPerFrame * factor, anchorX),
    seekToFrame,
    playheadFrame: () => playhead.frame(),
  };
}
