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

function runningExportOf(
  jobs: ReadonlyMap<string, EngineJob>,
  projectId: string,
  except: string | null,
): EngineJob | null {
  for (const job of jobs.values()) {
    if (job.kind !== "export" || job.projectId !== projectId || job.id === except) continue;
    if (job.state === "running") return job;
  }
  return null;
}

export interface FollowedExport {
  readonly job: EngineJob | null;
  /** An export this panel did not start but follows, by id, so its outcome stays on screen. */
  readonly adoptedJobId: string | null;
}

/**
 * The export to show: one adopted earlier, else the one started here, else a running export of
 * this project. The followed export stays on screen with its outcome after it ends, until another
 * export of the project starts (from the agent or another window), which is then adopted.
 */
export function followExportJob(
  jobs: ReadonlyMap<string, EngineJob>,
  projectId: string,
  startedJobId: string | null,
  adoptedJobId: string | null,
): FollowedExport {
  const followedId = adoptedJobId ?? startedJobId;
  const followed = followedId === null ? null : (jobs.get(followedId) ?? null);
  if (followedId !== null && (followed === null || followed.state === "running")) {
    // Running, or started here and not in the jobs stream yet.
    return { job: followed, adoptedJobId };
  }
  const next = runningExportOf(jobs, projectId, followedId);
  if (next !== null) return { job: next, adoptedJobId: next.id };
  return { job: followed, adoptedJobId };
}
