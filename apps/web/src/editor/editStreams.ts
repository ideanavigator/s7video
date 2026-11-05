// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** Folds for the Editor's streams (S7V-029): edit snapshots and engine jobs. */
import type { EditSnapshot, EngineJob, EngineJobsEvent } from "@t3tools/contracts";

/** Drops a snapshot older than one already shown, so a late reply never rolls the edit back. */
export function acceptNewerSnapshot(
  shownRevision: number,
  snapshot: EditSnapshot,
): readonly [number, ReadonlyArray<EditSnapshot>] {
  return snapshot.revision > shownRevision ? [snapshot.revision, [snapshot]] : [shownRevision, []];
}

/** Folds the jobs stream into the current jobs by id. */
export function applyJobsEvent(
  jobs: ReadonlyMap<string, EngineJob>,
  event: EngineJobsEvent,
): ReadonlyMap<string, EngineJob> {
  if (event.type === "snapshot") return new Map(event.jobs.map((job) => [job.id, job]));
  return new Map(jobs).set(event.job.id, event.job);
}

/** The export to show: the one started here, else a running export of this project. */
export function currentExportJob(
  jobs: ReadonlyMap<string, EngineJob>,
  projectId: string,
  startedJobId: string | null,
): EngineJob | null {
  if (startedJobId !== null) return jobs.get(startedJobId) ?? null;
  for (const job of jobs.values()) {
    if (job.kind === "export" && job.projectId === projectId && job.state === "running") return job;
  }
  return null;
}
