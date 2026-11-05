// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { EngineJobId, type EditSnapshot, type EngineJob } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { acceptNewerSnapshot, applyJobsEvent, currentExportJob } from "./editStreams";

const snapshot = (revision: number): EditSnapshot => ({
  revision,
  canUndo: revision > 0,
  canRedo: false,
  document: {
    version: 1,
    fps: { num: 30, den: 1 },
    canvas: { width: 1920, height: 1080 },
    media: [],
    tracks: [],
    markers: [],
    metadata: {},
  },
});

describe("editStore applies subscribed revisions in order", () => {
  it("passes newer revisions and ignores stale ones", () => {
    let shown = -1;
    const passed: number[] = [];
    for (const revision of [0, 2, 1, 2, 3]) {
      const [next, emitted] = acceptNewerSnapshot(shown, snapshot(revision));
      shown = next;
      passed.push(...emitted.map((entry) => entry.revision));
    }
    expect(passed).toEqual([0, 2, 3]);
    expect(shown).toBe(3);
  });
});

describe("applyJobsEvent", () => {
  const job = (id: string, progress: number): EngineJob => ({
    id: EngineJobId.make(id),
    kind: "export",
    progress,
    stage: null,
    state: "running",
  });

  it("replaces jobs on a snapshot and updates one job on an update", () => {
    const first = applyJobsEvent(new Map(), { type: "snapshot", jobs: [job("a", 0)] });
    const second = applyJobsEvent(first, { type: "updated", job: job("a", 0.5) });
    const third = applyJobsEvent(second, { type: "updated", job: job("b", 0.1) });
    expect(first.get("a")?.progress).toBe(0);
    expect(third.get("a")?.progress).toBe(0.5);
    expect([...third.keys()]).toEqual(["a", "b"]);
    expect(applyJobsEvent(third, { type: "snapshot", jobs: [] }).size).toBe(0);
  });
});

describe("currentExportJob", () => {
  const job = (id: string, overrides: Partial<EngineJob> = {}): EngineJob => ({
    id: EngineJobId.make(id),
    kind: "export",
    progress: 0.2,
    stage: null,
    state: "running",
    projectId: "project-1" as EngineJob["projectId"],
    ...overrides,
  });
  const jobs = new Map(
    [
      job("other-project", { projectId: "project-2" as EngineJob["projectId"] }),
      job("transcribe", { kind: "transcribe" }),
      job("done", { state: "succeeded" }),
      job("running"),
    ].map((entry) => [entry.id as string, entry]),
  );

  it("follows the export this panel started, whatever its state", () => {
    expect(currentExportJob(jobs, "project-1", "done")?.id).toBe("done");
    expect(currentExportJob(jobs, "project-1", "not-yet-listed")).toBeNull();
  });

  it("finds this project's running export after the panel remounts", () => {
    expect(currentExportJob(jobs, "project-1", null)?.id).toBe("running");
    expect(currentExportJob(jobs, "project-3", null)).toBeNull();
  });
});
