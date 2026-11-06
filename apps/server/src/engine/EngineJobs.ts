// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Running engine jobs and their progress, for `engine.jobs.subscribe`. In memory only: a job
// lives as long as its engine call, and a restart ends every job with it. Finished jobs stay in
// `recent` for a while, so an agent that checks after a job ended still learns how (S7V-058).
import type {
  EngineJob,
  EngineJobId,
  EngineJobState,
  EngineJobsEvent,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const RECENT_MS = 10 * 60 * 1000;
export const RECENT_MAX = 50;

export const make = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<EngineJobsEvent>();
  const jobs = new Map<EngineJobId, EngineJob>();
  let finished: Array<{ readonly job: EngineJob; readonly at: number }> = [];
  let counter = 0;

  const publish = (job: EngineJob) => PubSub.publish(events, { type: "updated", job });

  const start = (kind: string, projectId?: ProjectId) =>
    Effect.suspend(() => {
      counter += 1;
      const job: EngineJob = {
        id: `engine-job-${counter}` as EngineJobId,
        kind,
        progress: 0,
        stage: null,
        state: "running",
        ...(projectId === undefined ? {} : { projectId }),
      };
      jobs.set(job.id, job);
      return publish(job).pipe(Effect.as(job.id));
    });

  const progress = (id: EngineJobId, value: number, stage: string | null) =>
    Effect.suspend(() => {
      const job = jobs.get(id);
      if (!job) return Effect.void;
      const next = { ...job, progress: value, stage };
      jobs.set(id, next);
      return publish(next);
    });

  const keepFresh = (now: number) => {
    finished = finished.filter((entry) => now - entry.at < RECENT_MS).slice(-RECENT_MAX);
  };

  const finish = Effect.fn("EngineJobs.finish")(function* (
    id: EngineJobId,
    state: Exclude<EngineJobState, "running">,
    message?: string,
  ) {
    const job = jobs.get(id);
    if (!job) return;
    const now = yield* Clock.currentTimeMillis;
    jobs.delete(id);
    const done: EngineJob = {
      ...job,
      state,
      ...(state === "succeeded" ? { progress: 1 } : {}),
      ...(state === "failed" && message !== undefined ? { message } : {}),
    };
    finished.push({ job: done, at: now });
    keepFresh(now);
    yield* publish(done);
  });

  /** Jobs that ended in the last `RECENT_MS`, at most `RECENT_MAX`, oldest first. */
  const recent = Effect.map(Clock.currentTimeMillis, (now) => {
    keepFresh(now);
    return finished.map((entry) => entry.job);
  });

  const isRunning = (id: EngineJobId) => Effect.sync(() => jobs.has(id));

  const subscribe: Stream.Stream<EngineJobsEvent> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(events);
      const snapshot: EngineJobsEvent = { type: "snapshot", jobs: [...jobs.values()] };
      return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
    }),
  );

  return { start, progress, finish, isRunning, subscribe, recent };
});

export type EngineJobs = Effect.Success<typeof make>;
