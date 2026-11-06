// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EngineJobs from "./EngineJobs.ts";

describe("EngineJobs", () => {
  it.effect("records the project a job works for, so agent tools can scope to it", () =>
    Effect.gen(function* () {
      const jobs = yield* EngineJobs.make;
      const projectId = ProjectId.make("project-jobs");
      const owned = yield* jobs.start("transcribe", projectId);
      const loose = yield* jobs.start("export");
      const snapshot = yield* jobs.subscribe.pipe(Stream.runHead);
      expect(snapshot).toMatchObject({
        _tag: "Some",
        value: {
          type: "snapshot",
          jobs: [
            { id: owned, kind: "transcribe", projectId },
            { id: loose, kind: "export" },
          ],
        },
      });
      const [, second] =
        snapshot._tag === "Some" && snapshot.value.type === "snapshot" ? snapshot.value.jobs : [];
      expect(second).not.toHaveProperty("projectId");
    }),
  );

  it.effect("keeps finished jobs with their final state for a while (S7V-058)", () =>
    Effect.gen(function* () {
      const jobs = yield* EngineJobs.make;
      const projectId = ProjectId.make("project-jobs");
      const done = yield* jobs.start("transcribe", projectId);
      const stopped = yield* jobs.start("transcribe", projectId);
      const broken = yield* jobs.start("transcribe", projectId);
      yield* jobs.finish(done, "succeeded");
      yield* jobs.finish(stopped, "cancelled", "ignored for a cancel");
      yield* jobs.finish(broken, "failed", "The speech model could not load.");
      expect(yield* jobs.recent).toEqual([
        { id: done, kind: "transcribe", progress: 1, stage: null, state: "succeeded", projectId },
        {
          id: stopped,
          kind: "transcribe",
          progress: 0,
          stage: null,
          state: "cancelled",
          projectId,
        },
        {
          id: broken,
          kind: "transcribe",
          progress: 0,
          stage: null,
          state: "failed",
          projectId,
          message: "The speech model could not load.",
        },
      ]);
      // The live list (what the Editor shows) stays running jobs only.
      const snapshot = yield* jobs.subscribe.pipe(Stream.runHead);
      expect(snapshot).toMatchObject({ _tag: "Some", value: { type: "snapshot", jobs: [] } });

      yield* TestClock.adjust(EngineJobs.RECENT_MS);
      expect(yield* jobs.recent).toEqual([]);
    }),
  );

  it.effect("keeps at most RECENT_MAX finished jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* EngineJobs.make;
      for (let index = 0; index < EngineJobs.RECENT_MAX + 5; index++) {
        yield* jobs.finish(yield* jobs.start("export"), "succeeded");
      }
      const recent = yield* jobs.recent;
      expect(recent).toHaveLength(EngineJobs.RECENT_MAX);
      expect(recent[0]!.id).toBe("engine-job-6");
    }),
  );
});
