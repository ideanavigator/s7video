// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { EngineJobId, type EditSnapshot, type EngineJob } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { acceptNewerSnapshot, applyJobsEvent, followExportJob } from "./editStreams";

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

  it("passes a refusal notice at the shown revision, but not an older one", () => {
    const notice = (revision: number) => ({ ...snapshot(revision), notice: "Not kept." });
    expect(acceptNewerSnapshot(3, notice(3))).toEqual([3, [notice(3)]]);
    expect(acceptNewerSnapshot(3, notice(2))).toEqual([3, []]);
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

describe("followExportJob", () => {
  const job = (id: string, overrides: Partial<EngineJob> = {}): EngineJob => ({
    id: EngineJobId.make(id),
    kind: "export",
    progress: 0.2,
    stage: null,
    state: "running",
    projectId: "project-1" as EngineJob["projectId"],
    ...overrides,
  });
  const jobsOf = (...entries: ReadonlyArray<EngineJob>) =>
    new Map(entries.map((entry) => [entry.id as string, entry]));
  const jobs = jobsOf(
    job("other-project", { projectId: "project-2" as EngineJob["projectId"] }),
    job("transcribe", { kind: "transcribe" }),
    job("done", { state: "succeeded" }),
    job("running"),
  );

  it("follows the export this panel started, before and after it is listed", () => {
    expect(followExportJob(jobsOf(job("started")), "project-1", "started", null).job?.id).toBe(
      "started",
    );
    expect(followExportJob(jobs, "project-1", "not-yet-listed", null).job).toBeNull();
  });

  it("finds this project's running export after the panel remounts", () => {
    expect(followExportJob(jobs, "project-1", null, null)).toMatchObject({
      job: { id: "running" },
      adoptedJobId: "running",
    });
    expect(followExportJob(jobs, "project-3", null, null).job).toBeNull();
  });

  it("keeps following an export picked up after a remount to its end", () => {
    const { adoptedJobId } = followExportJob(jobs, "project-1", null, null);
    expect(adoptedJobId).toBe("running");
    for (const state of ["succeeded", "failed", "cancelled"] as const) {
      const ended = new Map(jobs).set("running", job("running", { state }));
      expect(followExportJob(ended, "project-1", null, adoptedJobId)).toMatchObject({
        job: { id: "running", state },
        adoptedJobId: "running",
      });
    }
  });

  it("moves to a newly running export once the followed one has ended", () => {
    const ended = jobsOf(job("first", { state: "succeeded" }), job("second"));
    // Adopted earlier, or started here: either way the new export takes over.
    expect(followExportJob(ended, "project-1", null, "first")).toMatchObject({
      job: { id: "second" },
      adoptedJobId: "second",
    });
    expect(followExportJob(ended, "project-1", "first", null)).toMatchObject({
      job: { id: "second" },
      adoptedJobId: "second",
    });
    // A running followed export is never replaced.
    const both = jobsOf(job("first"), job("second"));
    expect(followExportJob(both, "project-1", "first", null).job?.id).toBe("first");
  });
});
