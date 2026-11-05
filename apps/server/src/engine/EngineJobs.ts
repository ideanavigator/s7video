// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Running engine jobs and their progress, for `engine.jobs.subscribe`. In memory only: a job
// lives as long as its engine call, and a restart ends every job with it.
import type { EngineJob, EngineJobId, EngineJobState, EngineJobsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const make = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<EngineJobsEvent>();
  const jobs = new Map<EngineJobId, EngineJob>();
  let counter = 0;

  const publish = (job: EngineJob) => PubSub.publish(events, { type: "updated", job });

  const start = (kind: string) =>
    Effect.suspend(() => {
      counter += 1;
      const job: EngineJob = {
        id: `engine-job-${counter}` as EngineJobId,
        kind,
        progress: 0,
        stage: null,
        state: "running",
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

  const finish = (id: EngineJobId, state: Exclude<EngineJobState, "running">) =>
    Effect.suspend(() => {
      const job = jobs.get(id);
      if (!job) return Effect.void;
      jobs.delete(id);
      return publish({ ...job, state, ...(state === "succeeded" ? { progress: 1 } : {}) });
    });

  const isRunning = (id: EngineJobId) => Effect.sync(() => jobs.has(id));

  const subscribe: Stream.Stream<EngineJobsEvent> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(events);
      const snapshot: EngineJobsEvent = { type: "snapshot", jobs: [...jobs.values()] };
      return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
    }),
  );

  return { start, progress, finish, isRunning, subscribe };
});

export type EngineJobs = Effect.Success<typeof make>;
