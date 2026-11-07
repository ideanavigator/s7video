// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The multi-clip player's frame clock (S7V-039): the edit position in integer frames at item
 * `start`s, driven by the visible element's rVFC and by rAF across gaps, swapping a pool of
 * preloaded `<video>` elements at each join. Nothing runs while paused. See
 * docs/internals/player-clock.md.
 */
import type { EditRational } from "@t3tools/contracts";

import {
  editFrameInSegment,
  frameAtTime,
  nextTimelineSegmentFrom,
  sourceFrameInSegment,
  timelineSegmentAt,
  type TimelinePlan,
  type TimelineSegment,
  timeOfFrame,
} from "./editPlayback";

/** The parts of `HTMLVideoElement` the clock uses, so tests can drive it without media. */
export type ClockVideo = Pick<
  HTMLVideoElement,
  | "currentTime"
  | "paused"
  | "muted"
  | "src"
  | "readyState"
  | "play"
  | "pause"
  | "requestVideoFrameCallback"
  | "cancelVideoFrameCallback"
  | "addEventListener"
  | "removeEventListener"
>;

/** What the clock needs from the page around it. */
export interface PlayerClockHost {
  /** The element pool, in a fixed order; `show` names one by its index. */
  readonly videos: ReadonlyArray<ClockVideo>;
  /** Makes element `index` the only visible (and audible) one; `null` shows black. */
  readonly show: (index: number | null) => void;
  /** Milliseconds on the same clock as rVFC's `expectedDisplayTime` (`performance.now`). */
  readonly now: () => number;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
}

/** What shows at the clock's position: a playing or parked source, black, or a hold. */
export type PlayerClockState =
  | { readonly _tag: "source"; readonly segment: number; readonly mediaId: string }
  | { readonly _tag: "gap" }
  /** The segment's source has no URL (missing, failed or not resolved yet): black, clock runs. */
  | { readonly _tag: "missing"; readonly segment: number; readonly mediaId: string }
  /** Playback reached a segment whose element is not ready yet; the clock holds. */
  | { readonly _tag: "preparing"; readonly segment: number; readonly mediaId: string };

export interface PlayerClockEvents {
  /** The edit frame on screen: every frame while playing, once per seek. */
  readonly onFrame: (editFrame: number) => void;
  readonly onPlayingChange: (playing: boolean) => void;
  /** What shows changed (a join, a gap, a missing source); a few times a second at most. */
  readonly onStateChange?: (state: PlayerClockState) => void;
  /** An element failed to load or decode `mediaId`. */
  readonly onSourceError?: (mediaId: string) => void;
  /** Every swap at a join, for the playback golden and the dev counter. */
  readonly onJoin?: (sample: JoinSample) => void;
}

export interface JoinSample {
  readonly segment: number;
  /** The screen refresh the swap was committed for, and the one the join was due. */
  readonly displayAt: number;
  readonly dueAt: number;
  /** How long before the swap the element was parked on its first frame (negative: late). */
  readonly readyLeadMs: number;
}

export interface PlayerClock {
  /** A new plan (an edit changed): keeps the position, clamped, and keeps playing if it was. */
  readonly setPlan: (plan: TimelinePlan) => void;
  /** The URL each media plays from; `null` while it has none (missing, failed, resolving). */
  readonly setSource: (mediaId: string, url: string | null) => void;
  readonly play: () => void;
  readonly pause: () => void;
  readonly playing: () => boolean;
  /** Shows edit frame `frame` (clamped), keeping play or pause. */
  readonly seek: (frame: number) => void;
  readonly frame: () => number;
  readonly state: () => PlayerClockState;
  readonly dispose: () => void;
}

/** Elements in the pool: the one playing, the next one parked, and one keeping a source warm. */
export const PLAYER_POOL_SIZE = 3;

interface Slot {
  readonly index: number;
  readonly video: ClockVideo;
  mediaId: string | null;
  url: string | null;
  /** The segment this element is parked for, or -1. */
  segment: number;
  /** The source frame it is parked on, once `seeked` arrived. */
  parkedFrame: number | null;
  /** The source frame it is being parked on, or null. */
  target: number | null;
  readyAt: number;
  usedAt: number;
  /** Bumped on every park, so a stale `seeked` is ignored. */
  generation: number;
  cleanup: () => void;
}

/** True when `next` plays straight on from `segment` in the same source. */
const continues = (segment: TimelineSegment, next: TimelineSegment) =>
  next.start === segment.end &&
  next.mediaId === segment.mediaId &&
  next.in === segment.in + segment.end - segment.start &&
  next.muted === segment.muted;

const frameMsOf = (fps: EditRational) => (1000 * fps.den) / fps.num;

export function createPlayerClock(
  initialPlan: TimelinePlan,
  host: PlayerClockHost,
  events: PlayerClockEvents,
): PlayerClock {
  let plan = initialPlan;
  let frameMs = frameMsOf(plan.fps);
  const urls = new Map<string, string | null>();
  let frame = 0;
  let playing = false;
  let disposed = false;
  let state: PlayerClockState = { _tag: "gap" };
  /** The slot showing now, or null for black. */
  let active: Slot | null = null;
  let videoHandle: { slot: Slot; handle: number } | null = null;
  let animationHandle: number | null = null;
  /** The join out of this segment once its last frame is on screen; whichever loop sees it due first takes it. */
  let pendingJoin: { readonly index: number; readonly dueAt: number } | null = null;
  /** A screen refresh's length, measured from rAF while it runs (60 Hz until measured). */
  let refreshMs = 1000 / 60;
  let lastAnimationAt: number | null = null;

  const setState = (next: PlayerClockState) => {
    const same =
      next._tag === state._tag &&
      ("segment" in next ? next.segment : -1) === ("segment" in state ? state.segment : -1);
    state = next;
    if (!same) events.onStateChange?.(next);
  };

  const publish = (next: number) => {
    frame = next;
    events.onFrame(next);
  };

  const urlOf = (mediaId: string) => urls.get(mediaId) ?? null;

  const slots: Slot[] = host.videos.map((video, index) => {
    const slot: Slot = {
      index,
      video,
      mediaId: null,
      url: null,
      segment: -1,
      parkedFrame: null,
      target: null,
      readyAt: 0,
      usedAt: 0,
      generation: 0,
      cleanup: () => {},
    };
    const onError = () => {
      if (slot.mediaId === null) return;
      const mediaId = slot.mediaId;
      forget(slot);
      events.onSourceError?.(mediaId);
    };
    video.addEventListener("error", onError);
    slot.cleanup = () => video.removeEventListener("error", onError);
    return slot;
  });

  const forget = (slot: Slot) => {
    slot.generation += 1;
    slot.segment = -1;
    slot.parkedFrame = null;
    slot.target = null;
  };

  /** Parks `slot` paused on `sourceFrame` of `segment`; `onParked` runs once it shows that frame. */
  const park = (slot: Slot, segmentIndex: number, sourceFrame: number, onParked?: () => void) => {
    const segment = plan.segments[segmentIndex]!;
    const url = urlOf(segment.mediaId);
    if (url === null) return false;
    slot.generation += 1;
    const generation = slot.generation;
    slot.segment = segmentIndex;
    slot.parkedFrame = null;
    slot.target = sourceFrame;
    slot.usedAt = host.now();
    if (!slot.video.paused) slot.video.pause();
    const seekNow = () => {
      if (slot.generation !== generation) return;
      const onSeeked = () => {
        slot.video.removeEventListener("seeked", onSeeked);
        if (slot.generation !== generation) return;
        slot.parkedFrame = sourceFrame;
        slot.readyAt = host.now();
        onParked?.();
      };
      slot.video.addEventListener("seeked", onSeeked);
      slot.video.currentTime = timeOfFrame(sourceFrame, plan.fps);
    };
    if (slot.url !== url) {
      slot.url = url;
      slot.mediaId = segment.mediaId;
      const onMetadata = () => {
        slot.video.removeEventListener("loadedmetadata", onMetadata);
        seekNow();
      };
      slot.video.addEventListener("loadedmetadata", onMetadata);
      slot.video.src = url;
    } else {
      seekNow();
    }
    return true;
  };

  /** The element to park segment `index` on: never `except`, best one already holding its media. */
  const slotFor = (index: number, except: Slot | null): Slot => {
    const segment = plan.segments[index]!;
    const url = urlOf(segment.mediaId);
    const free = slots.filter((slot) => slot !== except);
    return (
      free.find((slot) => slot.segment === index && slot.url === url) ??
      free.find((slot) => slot.url === url && slot.url !== null) ??
      free.toSorted((left, right) => left.usedAt - right.usedAt)[0]!
    );
  };

  const isParkedFor = (slot: Slot, index: number) => {
    const segment = plan.segments[index];
    return (
      segment !== undefined &&
      slot.segment === index &&
      slot.url === urlOf(segment.mediaId) &&
      slot.parkedFrame === segment.in
    );
  };

  /** Parks the next playable segment after `index` on a free element, ahead of its join. */
  const prepareAfter = (index: number) => {
    for (let next = index + 1; next < plan.segments.length; next++) {
      const segment = plan.segments[next]!;
      if (urlOf(segment.mediaId) === null) continue;
      const slot = slotFor(next, active);
      const parking = slot.segment === next && slot.target === segment.in;
      if (!parking || slot.url !== urlOf(segment.mediaId)) park(slot, next, segment.in);
      return;
    }
  };

  const show = (slot: Slot | null) => {
    active = slot;
    for (const other of slots) {
      if (other === slot) continue;
      if (!other.video.paused) other.video.pause();
      other.video.muted = true;
    }
    if (slot !== null) {
      const segment = plan.segments[slot.segment];
      slot.video.muted = segment?.muted ?? true;
    }
    host.show(slot?.index ?? null);
  };

  const stopLoops = () => {
    if (videoHandle !== null) videoHandle.slot.video.cancelVideoFrameCallback(videoHandle.handle);
    videoHandle = null;
    if (animationHandle !== null) host.cancelFrame(animationHandle);
    animationHandle = null;
    lastAnimationAt = null;
    pendingJoin = null;
  };

  const animate = (step: (now: number) => void) => {
    animationHandle = host.requestFrame((now) => {
      animationHandle = null;
      if (lastAnimationAt !== null) {
        const delta = now - lastAnimationAt;
        if (delta > 4 && delta < 40) refreshMs = refreshMs * 0.8 + delta * 0.2;
      }
      lastAnimationAt = now;
      step(now);
    });
  };

  const watchVideo = (slot: Slot) => {
    videoHandle = { slot, handle: slot.video.requestVideoFrameCallback(onVideoFrame(slot)) };
  };

  const onVideoFrame =
    (slot: Slot): VideoFrameRequestCallback =>
    (_now, metadata) => {
      if (videoHandle?.slot === slot) videoHandle = null;
      if (!playing || active !== slot || state._tag !== "source") return;
      const index = state.segment;
      const segment = plan.segments[index]!;
      const presented = editFrameInSegment(segment, frameAtTime(metadata.mediaTime, plan.fps));
      if (pendingJoin !== null && pendingJoin.index === index && presented >= segment.end) {
        // The element reached a frame past its item before the animation frame swapped it. rVFC
        // runs in the rendering step that paints this frame, so swapping now keeps it off screen.
        const { dueAt } = pendingJoin;
        if (animationHandle !== null) host.cancelFrame(animationHandle);
        animationHandle = null;
        pendingJoin = null;
        enterFrame(segment.end, metadata.expectedDisplayTime, dueAt);
        return;
      }
      if (presented < segment.start) {
        // A frame from before the park landed late; wait for the next one.
        watchVideo(slot);
        return;
      }
      publish(Math.min(presented, segment.end - 1));
      const next = plan.segments[index + 1];
      if (presented >= segment.end - 1 && next !== undefined && continues(segment, next)) {
        // The next item carries on in the same source: no swap, the element plays on.
        slot.segment = index + 1;
        setState({ _tag: "source", segment: index + 1, mediaId: next.mediaId });
        prepareAfter(index + 1);
        watchVideo(slot);
        return;
      }
      if (presented >= segment.end - 1 && pendingJoin === null) {
        // The segment's last frame is on screen: the next item is due one frame time after it.
        const dueAt = metadata.expectedDisplayTime + (segment.end - presented) * frameMs;
        // The edit ends here: hold this frame rather than play into a frame export never shows.
        if (segment.end >= plan.durationFrames) slot.video.pause();
        pendingJoin = { index, dueAt };
        animate((now) => joinWhenDue(index, dueAt, now));
      }
      watchVideo(slot);
    };

  /** At the join out of segment `index`: waits for the refresh where the next item is due. */
  const joinWhenDue = (index: number, dueAt: number, now: number) => {
    if (!playing || pendingJoin?.index !== index) return;
    // This animation frame reaches the screen about one refresh after `now`.
    const displayAt = now + refreshMs;
    if (displayAt < dueAt - refreshMs / 2) {
      animate((later) => joinWhenDue(index, dueAt, later));
      return;
    }
    pendingJoin = null;
    const end = plan.segments[index]!.end;
    enterFrame(end, displayAt, dueAt);
  };

  /**
   * Playback reaches edit frame `at` at display time `displayAt`: start the segment there, or run
   * the gap clock until the next one.
   */
  const enterFrame = (at: number, displayAt: number, dueAt: number) => {
    if (at >= plan.durationFrames) {
      finish();
      return;
    }
    const index = timelineSegmentAt(plan.segments, at);
    if (index === -1) {
      runGap(at, displayAt);
      return;
    }
    const segment = plan.segments[index]!;
    if (urlOf(segment.mediaId) === null) {
      // No source: the item plays as black for its length, like a gap, labelled missing.
      runGap(at, displayAt, index);
      return;
    }
    const slot = slots.find((candidate) => isParkedFor(candidate, index));
    if (slot === undefined || at !== segment.start) {
      // Not parked in time (a very short segment, a slow disk): hold here until it is.
      holdFor(index, at);
      return;
    }
    startSegment(slot, index, displayAt, dueAt);
  };

  const startSegment = (slot: Slot, index: number, displayAt: number, dueAt: number) => {
    const segment = plan.segments[index]!;
    if (active !== null && active !== slot && !active.video.paused) active.video.pause();
    show(slot);
    setState({ _tag: "source", segment: index, mediaId: segment.mediaId });
    publish(segment.start);
    events.onJoin?.({ segment: index, displayAt, dueAt, readyLeadMs: displayAt - slot.readyAt });
    void slot.video.play().catch(() => {
      if (active === slot) pause();
    });
    watchVideo(slot);
    prepareAfter(index);
  };

  /** Black from edit frame `from`, counted on the host clock, until the next segment is due. */
  const runGap = (from: number, displayAt: number, missingSegment?: number) => {
    show(null);
    if (missingSegment === undefined) setState({ _tag: "gap" });
    else {
      const segment = plan.segments[missingSegment]!;
      setState({ _tag: "missing", segment: missingSegment, mediaId: segment.mediaId });
    }
    publish(from);
    const next = nextTimelineSegmentFrom(plan.segments, from);
    const until =
      missingSegment !== undefined
        ? plan.segments[missingSegment]!.end
        : next === -1
          ? plan.durationFrames
          : plan.segments[next]!.start;
    prepareAfter(missingSegment ?? (next === -1 ? plan.segments.length : next - 1));
    const tick = (now: number) => {
      if (!playing) return;
      const shownAt = now + refreshMs;
      const dueAt = displayAt + (until - from) * frameMs;
      if (shownAt >= dueAt - refreshMs / 2) {
        enterFrame(until, shownAt, dueAt);
        return;
      }
      // Whole frames since the gap began, never accumulated, so nothing drifts.
      const reached = Math.min(until - 1, from + Math.floor((shownAt - displayAt) / frameMs));
      if (reached !== frame) publish(reached);
      animate(tick);
    };
    animate(tick);
  };

  /** Playback is due to show segment `index` from `at`, but its element is not parked there. */
  const holdFor = (index: number, at: number) => {
    const segment = plan.segments[index]!;
    // The outgoing element holds its last frame rather than playing past its item.
    if (active !== null && !active.video.paused) active.video.pause();
    setState({ _tag: "preparing", segment: index, mediaId: segment.mediaId });
    publish(at);
    const slot = slotFor(index, null);
    const sourceFrame = sourceFrameInSegment(segment, at);
    const resume = () => {
      if (!playing || state._tag !== "preparing" || state.segment !== index) return;
      animate((now) => startParked(slot, index, at, now + refreshMs));
    };
    if (slot.segment === index && slot.parkedFrame === sourceFrame) resume();
    else if (slot.segment === index && slot.parkedFrame === null && slot.target === sourceFrame) {
      // Already parking for this join: resume when it lands.
      const generation = slot.generation;
      const poll = () => {
        if (!playing || slot.generation !== generation) return;
        if (slot.parkedFrame !== null) resume();
        else animate(poll);
      };
      animate(poll);
    } else park(slot, index, sourceFrame, resume);
  };

  /** Starts `slot`, parked at edit frame `at` of segment `index` (a seek or a late park). */
  const startParked = (slot: Slot, index: number, at: number, displayAt: number) => {
    const segment = plan.segments[index]!;
    show(slot);
    setState({ _tag: "source", segment: index, mediaId: segment.mediaId });
    publish(at);
    void slot.video.play().catch(() => {
      if (active === slot) pause();
    });
    events.onJoin?.({ segment: index, displayAt, dueAt: displayAt, readyLeadMs: 0 });
    watchVideo(slot);
    prepareAfter(index);
  };

  const finish = () => {
    stopLoops();
    if (active !== null && !active.video.paused) active.video.pause();
    playing = false;
    publish(Math.max(0, plan.durationFrames - 1));
    events.onPlayingChange(false);
  };

  /** Shows edit frame `at` paused: parks an element there, or shows black in a gap. */
  const showPaused = (at: number) => {
    const index = timelineSegmentAt(plan.segments, at);
    if (index === -1) {
      show(null);
      setState({ _tag: "gap" });
      prepareAfter(Math.max(-1, nextTimelineSegmentFrom(plan.segments, at) - 1));
      return;
    }
    const segment = plan.segments[index]!;
    if (urlOf(segment.mediaId) === null) {
      show(null);
      setState({ _tag: "missing", segment: index, mediaId: segment.mediaId });
      prepareAfter(index);
      return;
    }
    const slot = slotFor(index, null);
    const sourceFrame = sourceFrameInSegment(segment, at);
    setState({ _tag: "source", segment: index, mediaId: segment.mediaId });
    const generationAfterPark = slot.generation + 1;
    const parked = park(slot, index, sourceFrame, () => {
      // Shown only once its frame is decoded, so a seek never flashes the old frame.
      if (slot.generation !== generationAfterPark || playing) return;
      if (frame !== at) return;
      show(slot);
      prepareAfter(index);
    });
    if (!parked) show(null);
  };

  const seekTo = (target: number) => {
    const clamped = Math.max(0, Math.min(Math.trunc(target), Math.max(0, plan.durationFrames - 1)));
    const wasPlaying = playing;
    stopLoops();
    if (active !== null && !active.video.paused) active.video.pause();
    frame = clamped;
    publish(clamped);
    if (wasPlaying) {
      playing = true;
      playFrom(clamped);
    } else {
      showPaused(clamped);
    }
  };

  const playFrom = (at: number) => {
    const index = timelineSegmentAt(plan.segments, at);
    if (index === -1 || urlOf(plan.segments[index]!.mediaId) === null) {
      animate((now) => enterFrame(at, now + refreshMs, now + refreshMs));
      return;
    }
    const segment = plan.segments[index]!;
    const slot = active;
    if (
      slot !== null &&
      slot.segment === index &&
      slot.parkedFrame === sourceFrameInSegment(segment, at)
    ) {
      animate((now) => startParked(slot, index, at, now + refreshMs));
      return;
    }
    holdFor(index, at);
  };

  return {
    setPlan: (next) => {
      if (sameTimelinePlan(plan, next)) {
        plan = next;
        return;
      }
      plan = next;
      frameMs = frameMsOf(plan.fps);
      for (const slot of slots) forget(slot);
      seekTo(frame);
    },
    setSource: (mediaId, url) => {
      if (urls.get(mediaId) === url) return;
      urls.set(mediaId, url);
      // Elements holding the old URL reload it when next parked; the one playing finishes first.
      for (const slot of slots) {
        if (slot.mediaId === mediaId && slot !== active) {
          forget(slot);
          slot.url = null;
        }
      }
      if (!playing) seekTo(frame);
      else if (
        state._tag === "missing" ||
        (state._tag === "source" && state.mediaId === mediaId && active?.url !== url)
      ) {
        seekTo(frame);
      } else if (state._tag === "source") prepareAfter(state.segment);
    },
    play: () => {
      if (playing || disposed || plan.segments.length === 0) return;
      if (frame >= plan.durationFrames - 1) {
        frame = 0;
        publish(0);
      }
      playing = true;
      events.onPlayingChange(true);
      playFrom(frame);
    },
    pause: () => pause(),
    playing: () => playing,
    seek: (target) => seekTo(target),
    frame: () => frame,
    state: () => state,
    dispose: () => {
      disposed = true;
      stopLoops();
      playing = false;
      for (const slot of slots) {
        slot.cleanup();
        if (!slot.video.paused) slot.video.pause();
      }
    },
  };

  function pause() {
    if (!playing) return;
    stopLoops();
    playing = false;
    if (active !== null && !active.video.paused) active.video.pause();
    events.onPlayingChange(false);
    // Settle on a whole frame the paused element shows, so a resume starts exactly there.
    seekTo(frame);
  }
}

/** The segment and source frame shown at edit frame `frame`, or null in a gap. */
export function sourceAtEditFrame(
  plan: TimelinePlan,
  frame: number,
): { readonly segment: TimelineSegment; readonly sourceFrame: number } | null {
  const index = timelineSegmentAt(plan.segments, frame);
  if (index === -1) return null;
  const segment = plan.segments[index]!;
  return { segment, sourceFrame: sourceFrameInSegment(segment, frame) };
}

/** The next join after edit frame `frame`: where the shown source (or black) changes, or null. */
export function nextJoinAfter(plan: TimelinePlan, frame: number): number | null {
  const index = timelineSegmentAt(plan.segments, frame);
  if (index !== -1) {
    const end = plan.segments[index]!.end;
    return end < plan.durationFrames ? end : null;
  }
  const next = nextTimelineSegmentFrom(plan.segments, frame);
  return next === -1 ? null : plan.segments[next]!.start;
}

/** True when both plans play the same frames: the panel rebuilds its plan on every render. */
export function sameTimelinePlan(left: TimelinePlan, right: TimelinePlan): boolean {
  if (left === right) return true;
  if (left.fps.num !== right.fps.num || left.fps.den !== right.fps.den) return false;
  if (left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => {
    const other = right.segments[index]!;
    return (
      segment.mediaId === other.mediaId &&
      segment.start === other.start &&
      segment.end === other.end &&
      segment.in === other.in &&
      segment.muted === other.muted
    );
  });
}
