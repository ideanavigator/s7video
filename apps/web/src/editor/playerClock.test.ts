// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument, EditRational } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { editTimelinePlan, type TimelinePlan, type TimelineSegment } from "./editPlayback";
import {
  type ClockVideo,
  createPlayerClock,
  type JoinSample,
  nextJoinAfter,
  type PlayerClockState,
  sameTimelinePlan,
  sourceAtEditFrame,
} from "./playerClock";

/**
 * A simulated media pipeline: one tick is one screen refresh. Playing elements advance their
 * media time by the refresh and call their frame callbacks when a new source frame is presented;
 * loads and seeks land on the next tick, as they do (later) in a browser.
 */
class Simulation {
  now = 0;
  readonly refreshMs: number;
  private later: Array<() => void> = [];
  private animation = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;
  readonly videos: FakeVideo[];
  visible: number | null = null;
  /** URLs whose seeks take this many ticks (a slow disk), instead of one. */
  readonly slowSeeks = new Map<string, number>();

  constructor(
    readonly fps: EditRational,
    refreshHz = 60,
  ) {
    this.refreshMs = 1000 / refreshHz;
    this.videos = [0, 1, 2].map(() => new FakeVideo(this));
  }

  defer(callback: () => void, ticks = 1) {
    if (ticks <= 1) this.later.push(callback);
    else this.later.push(() => this.defer(callback, ticks - 1));
  }

  requestFrame = (callback: FrameRequestCallback) => {
    const handle = this.nextHandle++;
    this.animation.set(handle, callback);
    return handle;
  };

  cancelFrame = (handle: number) => {
    this.animation.delete(handle);
  };

  handle() {
    return this.nextHandle++;
  }

  tick() {
    this.now += this.refreshMs;
    const later = this.later;
    this.later = [];
    for (const callback of later) callback();
    for (const video of this.videos) video.advance(this.refreshMs);
    const animation = [...this.animation.values()];
    this.animation.clear();
    for (const callback of animation) callback(this.now);
  }

  run(ticks: number) {
    for (let index = 0; index < ticks; index++) this.tick();
  }

  /** The source shown now: element index and its source frame, or null for black. */
  shown(): { readonly video: number; readonly url: string; readonly frame: number } | null {
    if (this.visible === null) return null;
    const video = this.videos[this.visible]!;
    return { video: this.visible, url: video.src, frame: video.presentedFrame() };
  }
}

class FakeVideo extends EventTarget {
  paused = true;
  muted = false;
  readyState = 0;
  private url = "";
  private time = 0;
  private frameCallbacks = new Map<number, VideoFrameRequestCallback>();
  private lastPresented = -1;

  constructor(private readonly sim: Simulation) {
    super();
  }

  get src() {
    return this.url;
  }
  set src(value: string) {
    this.url = value;
    this.readyState = 0;
    this.sim.defer(() => {
      this.readyState = 4;
      this.dispatchEvent(new Event("loadedmetadata"));
    });
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    this.lastPresented = -1;
    this.sim.defer(
      () => this.dispatchEvent(new Event("seeked")),
      this.sim.slowSeeks.get(this.url) ?? 1,
    );
  }

  presentedFrame() {
    return Math.floor((this.time * this.sim.fps.num) / this.sim.fps.den + 1e-6);
  }

  play() {
    this.paused = false;
    // A parked element sits mid-frame; its first frame still shows a whole frame time, as the
    // spike measured (starting playback costs at least that).
    this.time = (this.presentedFrame() * this.sim.fps.den) / this.sim.fps.num;
    this.lastPresented = this.presentedFrame();
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    const handle = this.sim.handle();
    this.frameCallbacks.set(handle, callback);
    return handle;
  }
  cancelVideoFrameCallback(handle: number) {
    this.frameCallbacks.delete(handle);
  }

  advance(ms: number) {
    if (this.paused) return;
    this.time += ms / 1000;
    const frame = this.presentedFrame();
    if (frame === this.lastPresented) return;
    this.lastPresented = frame;
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    const mediaTime = (frame * this.sim.fps.den) / this.sim.fps.num;
    for (const callback of callbacks) {
      callback(this.sim.now, {
        mediaTime,
        expectedDisplayTime: this.sim.now + this.sim.refreshMs,
        presentationTime: this.sim.now,
        presentedFrames: frame,
        width: 1,
        height: 1,
        processingDuration: 0,
      } as VideoFrameCallbackMetadata);
    }
  }
}

const FPS_30 = { num: 30, den: 1 };

const segment = (
  mediaId: string,
  start: number,
  end: number,
  inFrame: number,
  muted = false,
): TimelineSegment => ({ mediaId, start, end, in: inFrame, muted });

const planOf = (fps: EditRational, segments: TimelineSegment[]): TimelinePlan => ({
  fps,
  segments,
  durationFrames: segments.at(-1)!.end,
  mediaIds: [...new Set(segments.map((entry) => entry.mediaId))],
});

const setUp = (plan: TimelinePlan, refreshHz = 60) => {
  const sim = new Simulation(plan.fps, refreshHz);
  const frames: number[] = [];
  const states: PlayerClockState[] = [];
  const joins: JoinSample[] = [];
  const playing: boolean[] = [];
  const clock = createPlayerClock(
    plan,
    {
      videos: sim.videos as unknown as ClockVideo[],
      show: (index) => {
        sim.visible = index;
      },
      now: () => sim.now,
      requestFrame: sim.requestFrame,
      cancelFrame: sim.cancelFrame,
    },
    {
      onFrame: (frame) => frames.push(frame),
      onPlayingChange: (next) => playing.push(next),
      onStateChange: (state) => states.push(state),
      onJoin: (sample) => joins.push(sample),
    },
  );
  for (const mediaId of plan.mediaIds) clock.setSource(mediaId, `media:${mediaId}`);
  sim.run(3);
  return { sim, clock, frames, states, joins, playing };
};

/** What edit frame the screen shows now, read back through the plan; -1 for black. */
const editFrameOnScreen = (sim: Simulation, plan: TimelinePlan, state: PlayerClockState) => {
  const shown = sim.shown();
  if (shown === null) return -1;
  if (state._tag !== "source") return -2;
  const current = plan.segments[state.segment]!;
  expect(shown.url).toBe(`media:${current.mediaId}`);
  return current.start + shown.frame - current.in;
};

// A gap, a reorder (B before A's earlier part), and a jump back inside A.
const MIXED = planOf(FPS_30, [
  segment("a", 0, 30, 10),
  segment("b", 30, 55, 200),
  segment("c", 70, 100, 40),
  segment("a", 100, 120, 0),
  segment("b", 120, 150, 5),
]);

describe("timeline plan", () => {
  it("should map edit frame to source and element", () => {
    expect(sourceAtEditFrame(MIXED, 0)).toEqual({ segment: MIXED.segments[0], sourceFrame: 10 });
    expect(sourceAtEditFrame(MIXED, 54)).toEqual({ segment: MIXED.segments[1], sourceFrame: 224 });
    expect(sourceAtEditFrame(MIXED, 60)).toBeNull();
    expect(sourceAtEditFrame(MIXED, 105)).toEqual({ segment: MIXED.segments[3], sourceFrame: 5 });
  });

  it("should find next join from current frame", () => {
    expect(nextJoinAfter(MIXED, 0)).toBe(30);
    expect(nextJoinAfter(MIXED, 30)).toBe(55);
    expect(nextJoinAfter(MIXED, 60)).toBe(70);
    expect(nextJoinAfter(MIXED, 149)).toBeNull();
  });

  it("builds the plan from item starts, with gaps, mutes and merged runs of one source", () => {
    const document = {
      fps: FPS_30,
      tracks: [
        {
          kind: "video",
          id: "v1",
          items: [
            { id: "i3", media: "b", start: 60, duration: 10, in: 0, muted: true },
            { id: "i1", media: "a", start: 5, duration: 20, in: 100 },
            { id: "i2", media: "a", start: 25, duration: 10, in: 120 },
          ],
        },
      ],
    } as unknown as EditDocument;
    expect(editTimelinePlan(document)).toEqual({
      fps: FPS_30,
      segments: [segment("a", 5, 35, 100), segment("b", 60, 70, 0, true)],
      durationFrames: 70,
      mediaIds: ["a", "b"],
    });
  });

  it("compares plans by what they play", () => {
    expect(sameTimelinePlan(MIXED, { ...MIXED, segments: [...MIXED.segments] })).toBe(true);
    expect(sameTimelinePlan(MIXED, { ...MIXED, segments: [segment("a", 0, 30, 11)] })).toBe(false);
  });
});

describe("createPlayerClock", () => {
  it("plays gaps as black and reordered clips in timeline order, with no frame held over one", () => {
    const { sim, clock, frames, joins } = setUp(MIXED);
    expect(sim.shown()).toEqual({ video: expect.any(Number), url: "media:a", frame: 10 });
    clock.play();
    // What a tick commits reaches the screen one refresh later, as in a browser.
    const startAt = sim.now + 2 * sim.refreshMs;
    const onScreen: Array<{ at: number; frame: number }> = [];
    while (clock.playing()) {
      sim.tick();
      const frame = editFrameOnScreen(sim, MIXED, clock.state());
      onScreen.push({ at: sim.now + sim.refreshMs, frame });
    }
    // Published frames step one at a time through the whole edit, gap included.
    const distinct = frames.filter((frame, index) => index === 0 || frame !== frames[index - 1]);
    expect(distinct.slice(distinct.indexOf(0))).toEqual(Array.from({ length: 150 }, (_, i) => i));
    // Each frame on screen is the one due at that time, within one frame; black only in the gap.
    const frameMs = 1000 / 30;
    for (const { at, frame } of onScreen.slice(0, -2)) {
      const due = Math.round((at - startAt) / frameMs);
      if (due > 55 && due < 69) expect(frame, `at ${due}`).toBe(-1);
      else if (frame !== -1) expect(Math.abs(frame - due), `at ${due}`).toBeLessThanOrEqual(1);
    }
    // Every join swapped on time, from an element already parked.
    expect(joins.map((join) => join.segment)).toEqual([0, 1, 2, 3, 4]);
    for (const join of joins.slice(1)) {
      expect(Math.abs(join.displayAt - join.dueAt)).toBeLessThanOrEqual(sim.refreshMs);
      expect(join.readyLeadMs).toBeGreaterThan(0);
    }
  });

  it("should handle two adjacent items from the same source", () => {
    const plan = planOf(FPS_30, [segment("a", 0, 20, 0), segment("a", 20, 40, 20)]);
    const { sim, clock, joins } = setUp(plan);
    const element = sim.visible;
    clock.play();
    sim.run(90);
    expect(clock.playing()).toBe(false);
    expect(sim.visible).toBe(element);
    expect(joins).toHaveLength(1);
  });

  it("should handle two adjacent items that jump within one source on two elements", () => {
    const plan = planOf(FPS_30, [segment("a", 0, 20, 100), segment("a", 20, 40, 0)]);
    const { sim, clock, joins } = setUp(plan);
    const first = sim.visible;
    clock.play();
    sim.run(50);
    expect(joins).toHaveLength(2);
    expect(sim.visible).not.toBe(first);
    expect(sim.shown()?.url).toBe("media:a");
  });

  it("should handle seeks during a join", () => {
    const { sim, clock, frames } = setUp(MIXED);
    clock.play();
    // Up to the last frame of the first segment, then seek into C (another source).
    while (clock.frame() < 29) sim.tick();
    clock.seek(80);
    expect(frames.at(-1)).toBe(80);
    sim.run(4);
    expect(clock.state()).toMatchObject({ _tag: "source", segment: 2, mediaId: "c" });
    expect(clock.playing()).toBe(true);
    const onScreen = editFrameOnScreen(sim, MIXED, clock.state());
    expect(onScreen).toBeGreaterThanOrEqual(80);
    expect(onScreen).toBeLessThanOrEqual(82);
  });

  it("seeks while paused show the exact frame, black in a gap", () => {
    const { sim, clock } = setUp(MIXED);
    clock.seek(110);
    sim.run(2);
    expect(sim.shown()).toEqual({ video: expect.any(Number), url: "media:a", frame: 10 });
    clock.seek(60);
    sim.run(2);
    expect(sim.shown()).toBeNull();
    expect(clock.state()).toEqual({ _tag: "gap" });
  });

  it("should handle a missing source file", () => {
    const { sim, clock, states } = setUp(MIXED);
    clock.setSource("b", null);
    clock.play();
    while (clock.playing()) sim.tick();
    expect(states).toContainEqual({ _tag: "missing", segment: 1, mediaId: "b" });
    expect(states).toContainEqual({ _tag: "source", segment: 3, mediaId: "a" });
    expect(clock.frame()).toBe(149);
  });

  it("should handle very short segments (under 0.3 s)", () => {
    const shorts = planOf(
      FPS_30,
      Array.from({ length: 12 }, (_, index) =>
        segment(["a", "b", "c"][index % 3]!, index * 6, index * 6 + 6, index * 40),
      ),
    );
    const { sim, clock, frames, states } = setUp(shorts);
    clock.play();
    while (clock.playing()) sim.tick();
    expect(states.some((state) => state._tag === "preparing")).toBe(false);
    expect(new Set(frames)).toEqual(new Set(Array.from({ length: 72 }, (_, i) => i)));
  });

  it("holds and resumes when a join is not parked in time", () => {
    const plan = planOf(FPS_30, [segment("a", 0, 2, 0), segment("b", 2, 30, 0)]);
    const { sim, clock, states } = setUp(plan);
    // Park B again, slowly: the two frames of A run out before it lands.
    clock.setSource("b", "media:b-slow");
    sim.slowSeeks.set("media:b-slow", 20);
    clock.play();
    sim.run(8);
    expect(clock.state()).toEqual({ _tag: "preparing", segment: 1, mediaId: "b" });
    expect(clock.frame()).toBe(2);
    sim.run(20);
    expect(states.at(-1)).toEqual({ _tag: "source", segment: 1, mediaId: "b" });
    expect(sim.shown()?.url).toBe("media:b-slow");
    expect(clock.frame()).toBeGreaterThan(2);
  });

  it("mutes muted items and the hidden elements", () => {
    const plan = planOf(FPS_30, [segment("a", 0, 10, 0), segment("b", 10, 20, 0, true)]);
    const { sim, clock } = setUp(plan);
    clock.play();
    sim.run(2);
    expect(sim.videos[sim.visible!]!.muted).toBe(false);
    while (clock.frame() < 12) sim.tick();
    expect(sim.videos[sim.visible!]!.muted).toBe(true);
    expect(sim.videos.filter((video) => !video.paused)).toHaveLength(1);
  });

  it("does nothing while paused", () => {
    const { sim, clock } = setUp(MIXED);
    clock.play();
    sim.run(20);
    clock.pause();
    sim.run(2);
    const frame = clock.frame();
    const requests = sim.requestFrame;
    let animationFrames = 0;
    sim.requestFrame = (callback) => {
      animationFrames++;
      return requests(callback);
    };
    sim.run(30);
    expect(clock.frame()).toBe(frame);
    expect(animationFrames).toBe(0);
    expect(sim.videos.every((video) => video.paused)).toBe(true);
  });

  it("keeps its position across an equal plan, and re-seeks on a changed one", () => {
    const { sim, clock } = setUp(MIXED);
    clock.seek(40);
    sim.run(2);
    clock.setPlan({ ...MIXED, segments: [...MIXED.segments] });
    expect(clock.frame()).toBe(40);
    clock.setPlan(planOf(FPS_30, [segment("a", 0, 20, 0)]));
    expect(clock.frame()).toBe(19);
  });

  it("should advance clock in whole frames at 30/1 and 30000/1001", () => {
    for (const fps of [FPS_30, { num: 30_000, den: 1_001 }]) {
      // Ten minutes of black, then one frame of a clip: the gap clock alone counts every frame.
      const tenMinutes = Math.round((600 * fps.num) / fps.den);
      const plan = planOf(fps, [segment("a", tenMinutes, tenMinutes + 2, 0)]);
      const { sim, clock, frames } = setUp(plan);
      clock.play();
      const startAt = sim.now + sim.refreshMs;
      while (clock.frame() < tenMinutes) sim.tick();
      const elapsedFrames = ((sim.now + sim.refreshMs - startAt) * fps.num) / (1000 * fps.den);
      expect(Math.abs(elapsedFrames - tenMinutes)).toBeLessThanOrEqual(1);
      expect(frames.every((frame) => Number.isInteger(frame))).toBe(true);
    }
  });
});
