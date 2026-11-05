// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor player's frame clock (S7V-029, ADR-007): one `<video>` plays the kept ranges and,
 * from `requestVideoFrameCallback`, seeks over each cut as the last kept frame shows. It runs only
 * while the video plays. A second preloaded `<video>` was measured and not needed: on proxies
 * and short-GOP sources the seek lands on the exact frame with p95 under 100 ms (S7V-029 check 1).
 */
import {
  frameAtTime,
  type PlaybackPlan,
  segmentIndexAt,
  sourceFrameOf,
  stepAfterFrame,
  timelineFrameOf,
  timeOfFrame,
} from "./editPlayback";
import { recordSkip } from "./editPlaybackMetrics";

/** The parts of `HTMLVideoElement` the loop uses, so tests can drive it without media. */
export type LoopVideo = Pick<
  HTMLVideoElement,
  | "currentTime"
  | "paused"
  | "play"
  | "pause"
  | "requestVideoFrameCallback"
  | "cancelVideoFrameCallback"
  | "addEventListener"
  | "removeEventListener"
>;

export interface PlaybackLoopEvents {
  /** Every presented frame while playing, as an edit frame. */
  readonly onFrame: (timelineFrame: number) => void;
  /** Playback reached the end of the edit. */
  readonly onEnd: () => void;
}

export interface PlaybackLoop {
  setPlan: (plan: PlaybackPlan) => void;
  /** Starts playing, first moving off a cut frame (or from the end back to the start). */
  play: () => Promise<void>;
  seekToTimelineFrame: (frame: number) => void;
  timelineFrame: () => number;
  /** True while a frame callback is pending; false whenever the video is paused. */
  running: () => boolean;
  dispose: () => void;
}

interface PendingSkip {
  readonly toFrame: number;
  readonly requestedAt: number;
  readonly lastDisplayAt: number;
  cutFramesShown: number;
}

export function createPlaybackLoop(video: LoopVideo, events: PlaybackLoopEvents): PlaybackLoop {
  let plan: PlaybackPlan | null = null;
  let handle: number | null = null;
  let pending: PendingSkip | null = null;
  let lastDisplayAt = 0;

  const sourceFrame = () => (plan === null ? 0 : frameAtTime(video.currentTime, plan.fps));
  const seekSource = (frame: number) => {
    if (plan !== null) video.currentTime = timeOfFrame(frame, plan.fps);
  };

  const onVideoFrame: VideoFrameRequestCallback = (now, metadata) => {
    handle = null;
    if (plan === null || video.paused) return;
    const { segments, fps } = plan;
    const presented = frameAtTime(metadata.mediaTime, fps);
    const displayAt = metadata.expectedDisplayTime;
    if (pending !== null) {
      if (presented >= pending.toFrame && segmentIndexAt(segments, presented) !== -1) {
        const frameMs = (1000 * fps.den) / fps.num;
        recordSkip({
          ms: displayAt - pending.requestedAt,
          landedOffFrames: presented - pending.toFrame,
          frozenFrames: Math.max(0, Math.round((displayAt - pending.lastDisplayAt) / frameMs) - 1),
          cutFramesShown: pending.cutFramesShown,
        });
        pending = null;
      } else {
        pending.cutFramesShown += 1;
      }
    }
    lastDisplayAt = displayAt;
    events.onFrame(timelineFrameOf(segments, presented));
    const step = pending === null ? stepAfterFrame(segments, presented) : { _tag: "play" as const };
    if (step._tag === "end") {
      video.pause();
      events.onEnd();
      return;
    }
    if (step._tag === "skip") {
      pending = {
        toFrame: step.toFrame,
        requestedAt: now,
        lastDisplayAt,
        cutFramesShown: 0,
      };
      seekSource(step.toFrame);
    }
    handle = video.requestVideoFrameCallback(onVideoFrame);
  };

  const start = () => {
    if (handle === null && plan !== null) handle = video.requestVideoFrameCallback(onVideoFrame);
  };
  const stop = () => {
    if (handle !== null) video.cancelVideoFrameCallback(handle);
    handle = null;
    pending = null;
  };
  video.addEventListener("play", start);
  video.addEventListener("pause", stop);
  video.addEventListener("ended", stop);

  return {
    setPlan: (next) => {
      plan = next;
      pending = null;
    },
    play: async () => {
      if (plan === null || plan.segments.length === 0) return;
      const frame = sourceFrame();
      const step = stepAfterFrame(plan.segments, frame);
      if (step._tag === "end") seekSource(plan.segments[0]!.sourceStart);
      else if (segmentIndexAt(plan.segments, frame) === -1 && step._tag === "skip") {
        seekSource(step.toFrame);
      }
      await video.play();
    },
    seekToTimelineFrame: (frame) => {
      if (plan === null || plan.segments.length === 0) return;
      const clamped = Math.max(0, Math.min(frame, plan.durationFrames - 1));
      seekSource(sourceFrameOf(plan.segments, clamped));
    },
    timelineFrame: () => (plan === null ? 0 : timelineFrameOf(plan.segments, sourceFrame())),
    running: () => handle !== null,
    dispose: () => {
      stop();
      video.removeEventListener("play", start);
      video.removeEventListener("pause", stop);
      video.removeEventListener("ended", stop);
    },
  };
}
