// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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
});
