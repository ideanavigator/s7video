// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The timeline's interaction logic (S7V-033), outside React so React Compiler compiles the
 * components (spike B1 bailed out on a component holding it): native scroll, zoom, click to seek,
 * keys and the playhead. Clips are percentages of span boxes this sizes, so a zoom step writes a
 * few widths here and React catches up the mounted window in a transition.
 */
import { observeResize } from "../../../lib/observeResize";
import type { PlayerFramePlan } from "../../../editor/editPlayback";
import { createPlayheadDriver, type PlayheadDriver } from "./playheadDriver";
import type { TimelineView, TimelineViewSource } from "./timelineView";
import {
  type VisibleWindow,
  visibleWindow,
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
import { SPAN_ATTRIBUTE } from "./laneGeometry";
import { TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX } from "./vendor/opencut/theme";

export interface TimelineSnapshot {
  /** The zoom React last laid out at; clips follow a zoom at once through the span boxes. */
  readonly pxPerFrame: number;
  /** The scale LOD decides at (`lod.ts`); lags `pxPerFrame` inside the hysteresis band. */
  readonly detailScale: number;
  /** Frames whose clips are mounted: the screen plus two quarter-screen buckets either side. */
  readonly window: VisibleWindow;
  /** Visible lane width: the scroll container minus the sticky track labels. */
  readonly laneWidthPx: number;
  readonly durationFrames: number;
}

export interface TimelineController extends TimelineViewSource {
  /** Calls the listener once at once, then on every change; see `emit` for `urgent`. */
  readonly subscribe: (listener: (urgent: boolean) => void) => () => void;
  readonly getSnapshot: () => TimelineSnapshot;
  /** Ref callbacks; each returns its cleanup. */
  readonly attachScroller: (element: HTMLDivElement | null) => (() => void) | undefined;
  readonly attachContent: (element: HTMLDivElement | null) => void;
  readonly attachPlayhead: (element: HTMLDivElement | null) => void;
  readonly attachSlider: (element: HTMLDivElement | null) => void;
  readonly setDuration: (durationFrames: number) => void;
  /** The rows' total height, which React knows; the wheel decides with it without a layout read. */
  readonly setContentHeight: (heightPx: number) => void;
  /** The player's plan, for mapping its frames (`editFrames.ts`). */
  readonly setPlan: (plan: PlayerFramePlan | null) => void;
  /** Sizes span boxes React mounted since the last zoom (`laneGeometry.ts`). */
  readonly sizeSpans: () => void;
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
/** Mid-gesture, React re-lays the ruler once the zoom moved this far from what it rendered. */
const ZOOM_RENDER_RATIO_MIN = 0.7;
const ZOOM_RENDER_RATIO_MAX = 1.6;
const ZOOM_SETTLE_MS = 120;
/** Where the playhead lands after following playback off the right edge. */
const FOLLOW_MARGIN_FRACTION = 0.1;

export function createTimelineController(options: TimelineControllerOptions): TimelineController {
  const listeners = new Set<(urgent: boolean) => void>();
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
  /**
   * Scroll offsets, sizes and the scroller's position, kept from scroll and resize events so the
   * wheel, zoom and playback paths never read layout (a read after a commit forces a restyle).
   */
  let scrollLeftNow = 0;
  let scrollTopNow = 0;
  let viewportHeight = 0;
  let contentHeight = 0;
  let scrollerLeft = 0;
  const viewListeners = new Set<(view: TimelineView) => void>();
  let view: TimelineView = { pxPerFrame, startFrame: 0, endFrame: 0 };

  /** Nothing is mounted past the content's end, so it never widens the scroll range. */
  function clampWindow(window: VisibleWindow): VisibleWindow {
    const lanes = contentWidthPx(durationFrames, pxPerFrame, laneWidth);
    const endPx = Math.min(window.endPx, lanes);
    return {
      ...window,
      endPx,
      endFrame: Math.min(window.endFrame, Math.floor(lanes / pxPerFrame)),
    };
  }

  function makeSnapshot(): TimelineSnapshot {
    return {
      pxPerFrame,
      detailScale,
      window: clampWindow(visibleWindow(bucket, bucketPx, laneWidth, pxPerFrame)),
      laneWidthPx: laneWidth,
      durationFrames,
    };
  }

  /** `urgent` is false for scroll and zoom steps, which React may render a few frames late. */
  const emit = (urgent: boolean) => {
    const next = makeSnapshot();
    if (
      next.pxPerFrame === snapshot.pxPerFrame &&
      next.detailScale === snapshot.detailScale &&
      next.window.startFrame === snapshot.window.startFrame &&
      next.window.endFrame === snapshot.window.endFrame &&
      next.laneWidthPx === snapshot.laneWidthPx &&
      next.durationFrames === snapshot.durationFrames
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener(urgent);
  };

  /** The content's size and the zoom variable, owned here so a late React commit cannot undo them. */
  /** Clips are percentages of the span boxes (`laneGeometry.ts`), so this is all a zoom writes. */
  const writeGeometry = () => {
    if (content === null) return;
    const lanes = contentWidthPx(durationFrames, pxPerFrame, laneWidth);
    content.style.width = `${lanes + TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX}px`;
    const span = `${Math.max(1, durationFrames) * pxPerFrame}px`;
    for (const element of content.querySelectorAll<HTMLElement>(`[${SPAN_ATTRIBUTE}]`)) {
      if (element.style.width !== span) element.style.width = span;
    }
  };

  const lastFrame = () => Math.max(0, durationFrames - 1);

  /** Publishes what is on screen to `subscribeView`, and as attributes the perf test reads. */
  const writeView = () => {
    const startFrame = scrollLeftNow / pxPerFrame;
    const endFrame = Math.min(
      (scrollLeftNow + laneWidth) / pxPerFrame,
      contentWidthPx(durationFrames, pxPerFrame, laneWidth) / pxPerFrame,
    );
    if (
      view.pxPerFrame === pxPerFrame &&
      view.startFrame === startFrame &&
      view.endFrame === endFrame
    ) {
      return;
    }
    view = { pxPerFrame, startFrame, endFrame };
    if (scroller !== null) {
      scroller.dataset.viewStart = String(startFrame);
      scroller.dataset.viewEnd = String(endFrame);
    }
    for (const listener of viewListeners) listener(view);
  };

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
    const left = scrollLeftNow;
    const inView = x >= left && x <= left + laneWidth;
    if (!inView && lastPlayheadInView && x > left) {
      scrollLeftNow = Math.max(0, x - laneWidth * FOLLOW_MARGIN_FRACTION);
      scroller.scrollLeft = scrollLeftNow;
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
    const result = zoomAround(scrollLeftNow, pxPerFrame, clamped, anchorX);
    pxPerFrame = result.pxPerFrame;
    detailScale = nextDetailScale(detailScale, pxPerFrame);
    // Widen the content before scrolling, so the browser does not clamp the anchored position.
    writeGeometry();
    const maxScroll = Math.max(
      0,
      contentWidthPx(durationFrames, pxPerFrame, laneWidth) - laneWidth,
    );
    const scrollLeft = Math.min(result.scrollLeft, maxScroll);
    if (scroller !== null) scroller.scrollLeft = scrollLeft;
    scrollLeftNow = scrollLeft;
    bucket = bucketOf(scrollLeft, bucketPx);
    playhead.setPxPerFrame(pxPerFrame);
    writeView();
    zoomRender(scrollLeft);
  };

  /**
   * While a zoom gesture runs, CSS already moves every mounted clip, so React renders only when
   * the mounted window stops covering the screen or the ruler's spacing drifts too far; the
   * gesture settles with one render once it pauses.
   */
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    settleTimer = null;
    emit(false);
  };
  const zoomRender = (scrollLeft: number) => {
    const rendered = snapshot;
    const ratio = pxPerFrame / rendered.pxPerFrame;
    const lanes = contentWidthPx(durationFrames, pxPerFrame, laneWidth);
    const first = scrollLeft / pxPerFrame;
    const last = Math.min(scrollLeft + laneWidth, lanes) / pxPerFrame;
    const covered = rendered.window.startFrame <= first && rendered.window.endFrame >= last;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    if (!covered || ratio < ZOOM_RENDER_RATIO_MIN || ratio > ZOOM_RENDER_RATIO_MAX) {
      emit(false);
      return;
    }
    settleTimer = setTimeout(settle, ZOOM_SETTLE_MS);
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
    bucket = bucketOf(scrollLeftNow, bucketPx);
    writeGeometry();
    writeView();
  };

  /** Layout reads, only from resize callbacks (after layout) and pointer down. */
  const measureScroller = () => {
    if (scroller === null) return;
    scrollerLeft = scroller.getBoundingClientRect().left;
    viewportHeight = scroller.clientHeight;
  };
  const laneXOfClient = (clientX: number): number | null => {
    if (scroller === null) return null;
    const x = clientX - scrollerLeft - TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX;
    return x < 0 ? null : x;
  };

  const seekToFrame = (editFrame: number) => {
    const frame = Math.max(0, Math.min(lastFrame(), Math.trunc(editFrame)));
    playhead.place(frame);
    seekHandler(frame);
  };

  const onScroll = () => {
    if (scroller === null) return;
    // The scroll event is the one place offsets are read; it fires after the scroll happened.
    scrollLeftNow = scroller.scrollLeft;
    scrollTopNow = scroller.scrollTop;
    writeView();
    const next = bucketOf(scrollLeftNow, bucketPx);
    if (next === bucket) return;
    bucket = next;
    // Always render a bucket crossing, even while a zoom gesture defers its own renders.
    emit(false);
  };

  let pendingWheel = 0;
  let wheelAnchor = 0;
  let wheelFrame = 0;
  const onWheel = (event: WheelEvent) => {
    if (scroller === null) return;
    const scale = event.deltaMode === 0 ? 1 : WHEEL_LINE_PX;
    if (!(event.ctrlKey || event.metaKey)) {
      const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
      if (!vertical || event.shiftKey) return;
      // A mouse wheel scrolls the edit sideways, as in CapCut. When the rows are taller than the
      // timeline it scrolls them first, and sideways again once they reach their top or bottom.
      if (wheelScrollsRows(event.deltaY, scrollTopNow, contentHeight, viewportHeight)) return;
      event.preventDefault();
      const maxScroll = contentWidthPx(durationFrames, pxPerFrame, laneWidth) - laneWidth;
      scrollLeftNow = Math.max(0, Math.min(maxScroll, scrollLeftNow + event.deltaY * scale));
      scroller.scrollLeft = scrollLeftNow;
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
    measureScroller();
    const x = laneXOfClient(event.clientX);
    if (x === null) return;
    seekToFrame(frameAtPx(scrollLeftNow + x, pxPerFrame, lastFrame()));
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
    seekToFrame(frameAtPx(scrollLeftNow + x, pxPerFrame, lastFrame()));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (scrubbing === event.pointerId) scrubbing = null;
  };

  const playheadAnchorX = () => {
    const x = playhead.frame() * pxPerFrame - scrollLeftNow;
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
      listener(true);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getView: () => view,
    subscribeView: (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    attachScroller: (element) => {
      scroller = element;
      if (element === null) return undefined;
      laneWidth = Math.max(1, element.clientWidth - TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX);
      scrollLeftNow = element.scrollLeft;
      scrollTopNow = element.scrollTop;
      measureScroller();
      relimit();
      emit(true);
      const disconnect = playhead.connect();
      element.addEventListener("scroll", onScroll, { passive: true });
      element.addEventListener("wheel", onWheel, { passive: false });
      element.addEventListener("pointerdown", onPointerDown);
      element.addEventListener("pointermove", onPointerMove);
      element.addEventListener("pointerup", onPointerUp);
      element.addEventListener("pointercancel", onPointerUp);
      element.addEventListener("keydown", onKeyDown);
      // The panel can move without the timeline resizing (a window resize moves it sideways).
      window.addEventListener("resize", measureScroller);
      const stopResize = observeResize(element, () => {
        measureScroller();
        const next = Math.max(1, element.clientWidth - TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX);
        if (next === laneWidth) return;
        laneWidth = next;
        relimit();
        emit(true);
      });
      return () => {
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = null;
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
        window.removeEventListener("resize", measureScroller);
        if (scroller === element) scroller = null;
      };
    },
    attachContent: (element) => {
      content = element;
      writeGeometry();
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
      emit(true);
    },
    sizeSpans: writeGeometry,
    setContentHeight: (next) => {
      contentHeight = next;
    },
    setPlan: (plan) => playhead.setPlan(plan),
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

/** Whether a vertical wheel of `deltaY` scrolls the rows, rather than the edit sideways. */
export function wheelScrollsRows(
  deltaY: number,
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
): boolean {
  const maxTop = contentHeight - viewportHeight;
  if (maxTop <= 1) return false;
  return deltaY < 0 ? scrollTop > 0.5 : scrollTop < maxTop - 0.5;
}
