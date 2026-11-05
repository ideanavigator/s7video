// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { EditRational } from "@t3tools/contracts";

import { clipPlaybackPlan, frameAtTime, type PlaybackPlan, timeOfFrame } from "./editPlayback";
import { createPlaybackLoop, type LoopVideo } from "./editPlaybackLoop";
import { resetSkips, summarizeSkips } from "./editPlaybackMetrics";

const FPS = { num: 30, den: 1 };

interface FakeVideoOptions {
  readonly fps?: EditRational;
  /** Frames a seek takes to show its frame; the last frame stays on screen meanwhile. */
  readonly seekLatencyFrames?: number;
  /** Timestamps stored in whole milliseconds, as WebM does. */
  readonly millisecondTimestamps?: boolean;
}

/**
 * A `<video>` that presents one frame per `present()`. A seek shows the frame whose timestamp
 * holds the requested time, after `seekLatencyFrames` presents with nothing new on screen.
 */
class FakeVideo extends EventTarget {
  paused = true;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  readonly presented: number[] = [];
  private nextHandle = 1;
  private clock = 0;
  private frame = 0;
  private seek: { frame: number; time: number; wait: number } | null = null;
  private readonly fps: EditRational;
  private readonly latency: number;
  private readonly roundMs: boolean;

  constructor(options: FakeVideoOptions = {}) {
    super();
    this.fps = options.fps ?? FPS;
    this.latency = options.seekLatencyFrames ?? 0;
    this.roundMs = options.millisecondTimestamps ?? false;
  }

  private timestampOf(frame: number): number {
    const exact = (frame * this.fps.den) / this.fps.num;
    return this.roundMs ? Math.round(exact * 1000) / 1000 : exact;
  }

  get currentTime(): number {
    return this.seek?.time ?? this.timestampOf(this.frame);
  }
  set currentTime(time: number) {
    let frame = Math.floor((time * this.fps.num) / this.fps.den);
    while (this.timestampOf(frame + 1) <= time) frame += 1;
    while (frame > 0 && this.timestampOf(frame) > time) frame -= 1;
    this.seek = { frame, time, wait: this.paused ? 0 : this.latency };
    if (this.paused) {
      this.frame = frame;
      this.seek = null;
    }
  }

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
  /** One display refresh at the clip's rate: a new frame, or the old one while a seek runs. */
  present(): number | null {
    this.clock += (1000 * this.fps.den) / this.fps.num;
    if (this.seek !== null && this.seek.wait > 0) {
      this.seek.wait -= 1;
      return null;
    }
    if (this.seek !== null) {
      this.frame = this.seek.frame;
      this.seek = null;
    }
    const frame = this.frame;
    this.presented.push(frame);
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) {
      callback(this.clock, {
        mediaTime: this.timestampOf(frame),
        expectedDisplayTime: this.clock,
        presentationTime: this.clock,
        presentedFrames: this.presented.length,
        width: 1920,
        height: 1080,
      });
    }
    if (this.seek === null && !this.paused) this.frame = frame + 1;
    return frame;
  }
}

const keepPlan = (
  ranges: ReadonlyArray<readonly [number, number]>,
  fps: EditRational = FPS,
): PlaybackPlan => {
  let timeline = 0;
  const segments = ranges.map(([start, end]) => {
    const segment = { sourceStart: start, sourceEnd: end, timelineStart: timeline };
    timeline += end - start;
    return segment;
  });
  return { mediaId: "clip", fps, segments, durationFrames: timeline, otherClipItems: 0 };
};

const setup = (plan: PlaybackPlan, options: FakeVideoOptions = {}) => {
  const video = new FakeVideo({ fps: plan.fps, ...options });
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

  it("drops a skip in flight when the user seeks, so the cut is still skipped", async () => {
    const { video, loop } = setup(
      keepPlan([
        [0, 10],
        [20, 30],
        [40, 50],
      ]),
      { seekLatencyFrames: 3 },
    );
    await loop.play();
    for (let index = 0; index < 10; index += 1) video.present();
    // The skip to frame 20 is still loading when the user goes back to the start.
    video.present();
    loop.seekToTimelineFrame(0);
    const shown = video.presented.length;
    playThrough(video);
    const after = video.presented.slice(shown);
    expect(
      after.filter((frame) => (frame >= 10 && frame < 20) || (frame >= 30 && frame < 40)),
    ).toEqual([]);
    expect(after.at(-1)).toBe(49);
  });
});

/** About 40 keep ranges of 2 to 40 frames with cuts of 1 to 30 frames, from a fixed seed. */
const silenceCut = (fps: EditRational) => {
  let seed = 20_261_106;
  const next = (low: number, high: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return low + (seed % (high - low + 1));
  };
  const ranges: Array<readonly [number, number]> = [];
  let frame = next(0, 10);
  for (let index = 0; index < 40; index += 1) {
    const end = frame + next(2, 40);
    ranges.push([frame, end]);
    frame = end + next(1, 30);
  }
  return keepPlan(ranges, fps);
};

describe("createPlaybackLoop with real-world timing (S7V-043 replaces it with a browser golden)", () => {
  const cases = [
    { name: "29.97", fps: { num: 30_000, den: 1_001 } },
    { name: "23.976", fps: { num: 24_000, den: 1_001 } },
  ].flatMap((rate) => [0, 1, 3].map((latency) => ({ ...rate, latency })));
  it.each(cases)(
    "at $name fps with millisecond timestamps and seeks $latency frames late",
    async ({ fps, latency }) => {
      const plan = silenceCut(fps);
      const { video, loop, ended } = setup(plan, {
        seekLatencyFrames: latency,
        millisecondTimestamps: true,
      });
      await loop.play();
      playThrough(video);
      const kept = plan.segments.flatMap((segment) =>
        Array.from(
          { length: segment.sourceEnd - segment.sourceStart },
          (_, index) => segment.sourceStart + index,
        ),
      );
      // Every kept frame once, in order, and no cut frame.
      expect(video.presented).toEqual(kept);
      expect(ended()).toBe(1);
      const summary = summarizeSkips();
      expect(summary.skips).toBe(plan.segments.length - 1);
      expect(summary.maxLandedOffFrames).toBe(0);
      expect(summary.cutFramesShown).toBe(0);
      expect(summary.maxFrozenFrames).toBe(latency);
    },
  );
});
