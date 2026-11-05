// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clipPlaybackPlan, frameAtTime, type PlaybackPlan, timeOfFrame } from "./editPlayback";
import { createPlaybackLoop, type LoopVideo } from "./editPlaybackLoop";
import { resetSkips, summarizeSkips } from "./editPlaybackMetrics";

const FPS = { num: 30, den: 1 };
const FRAME_MS = 1000 / 30;

/** A `<video>` that presents one frame per `present()`, and lands a seek on the next one. */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  private nextHandle = 1;
  private clock = 0;
  readonly presented: number[] = [];

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }
  cancelVideoFrameCallback(handle: number): void {
    this.callbacks.delete(handle);
  }
  async play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  /** Shows the frame at `currentTime`, runs the frame callbacks, then advances one frame. */
  present(): number {
    const frame = frameAtTime(this.currentTime, FPS);
    this.presented.push(frame);
    this.clock += FRAME_MS;
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    const before = this.currentTime;
    for (const callback of pending) {
      callback(this.clock, {
        mediaTime: (frame * FPS.den) / FPS.num,
        expectedDisplayTime: this.clock,
        presentationTime: this.clock,
        presentedFrames: this.presented.length,
        width: 1920,
        height: 1080,
      });
    }
    if (this.currentTime === before && !this.paused) this.currentTime = timeOfFrame(frame + 1, FPS);
    return frame;
  }
}

const keepPlan = (ranges: ReadonlyArray<readonly [number, number]>): PlaybackPlan => {
  let timeline = 0;
  const segments = ranges.map(([start, end]) => {
    const segment = { sourceStart: start, sourceEnd: end, timelineStart: timeline };
    timeline += end - start;
    return segment;
  });
  return { mediaId: "clip", fps: FPS, segments, durationFrames: timeline, otherClipItems: 0 };
};

const setup = (plan: PlaybackPlan) => {
  const video = new FakeVideo();
  const frames: number[] = [];
  let ended = 0;
  const loop = createPlaybackLoop(video as unknown as LoopVideo, {
    onFrame: (frame) => frames.push(frame),
    onEnd: () => {
      ended += 1;
    },
  });
  loop.setPlan(plan);
  return { video, loop, frames, ended: () => ended };
};

const playThrough = (video: FakeVideo, limit = 10_000) => {
  for (let index = 0; index < limit && !video.paused; index += 1) video.present();
};

beforeEach(() => resetSkips());

describe("createPlaybackLoop", () => {
  it("skips every removed range and lands on the next kept frame", async () => {
    const { video, loop, frames, ended } = setup(
      keepPlan([
        [0, 10],
        [20, 25],
        [40, 50],
      ]),
    );
    await loop.play();
    playThrough(video);
    expect(video.presented).toEqual([
      ...Array.from({ length: 10 }, (_, index) => index),
      ...Array.from({ length: 5 }, (_, index) => 20 + index),
      ...Array.from({ length: 10 }, (_, index) => 40 + index),
    ]);
    expect(frames).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(ended()).toBe(1);
    const summary = summarizeSkips();
    expect(summary.skips).toBe(2);
    expect(summary.maxLandedOffFrames).toBe(0);
    expect(summary.cutFramesShown).toBe(0);
  });

  it("should handle many tiny cuts: 300 cuts, each skip within 1 frame", async () => {
    const ranges = Array.from({ length: 301 }, (_, index) => [index * 3, index * 3 + 2] as const);
    const { video, loop } = setup(keepPlan(ranges));
    await loop.play();
    playThrough(video);
    expect(video.presented.some((frame) => frame % 3 === 2)).toBe(false);
    const summary = summarizeSkips();
    expect(summary.skips).toBe(300);
    expect(summary.maxLandedOffFrames).toBeLessThanOrEqual(1);
  });

  it("should stop the frame loop when paused", async () => {
    const { video, loop } = setup(keepPlan([[0, 100]]));
    expect(loop.running()).toBe(false);
    await loop.play();
    video.present();
    expect(loop.running()).toBe(true);
    video.pause();
    expect(loop.running()).toBe(false);
    expect(video.callbacks.size).toBe(0);
  });

  it("starts from the next kept frame when play is pressed on a cut", async () => {
    const { video, loop } = setup(
      keepPlan([
        [0, 10],
        [20, 30],
      ]),
    );
    video.currentTime = timeOfFrame(14, FPS);
    await loop.play();
    expect(video.present()).toBe(20);
  });

  it("starts again from the first kept frame after the end", async () => {
    const { video, loop } = setup(keepPlan([[5, 10]]));
    video.currentTime = timeOfFrame(9, FPS);
    await loop.play();
    playThrough(video);
    await loop.play();
    expect(video.present()).toBe(5);
  });

  it("follows a new plan while playing", async () => {
    const { video, loop } = setup(clipPlaybackPlan("clip", 100, FPS));
    await loop.play();
    for (let index = 0; index < 5; index += 1) video.present();
    loop.setPlan(
      keepPlan([
        [0, 6],
        [50, 60],
      ]),
    );
    video.present();
    expect(video.present()).toBe(50);
  });

  it("seeks by edit frame, clamped to the edit", () => {
    const { video, loop } = setup(
      keepPlan([
        [0, 10],
        [20, 30],
      ]),
    );
    loop.seekToTimelineFrame(12);
    expect(frameAtTime(video.currentTime, FPS)).toBe(22);
    expect(loop.timelineFrame()).toBe(12);
    loop.seekToTimelineFrame(500);
    expect(frameAtTime(video.currentTime, FPS)).toBe(29);
  });
});
