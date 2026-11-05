// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Edit state for the Editor panel (S7V-029), keyed by project: every thread of a project shows the
 * same edit. The document comes from `edit.subscribe`; the player's place and what it plays live
 * in a small store; the playing frame goes to listeners (the transcript) without React state.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EditSnapshot,
  type EngineJob,
  type EnvironmentId,
  type ExportStatus,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { Cause, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "../state/server";
import { acceptNewerSnapshot, applyJobsEvent, currentExportJob } from "./editStreams";

export const editEnvironment = {
  edit: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:edit:subscribe",
    tag: WS_METHODS.editSubscribe,
    transform: (stream) => stream.pipe(Stream.mapAccum(() => -1, acceptNewerSnapshot)),
  }),
  jobs: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:engine:jobs",
    tag: WS_METHODS.engineJobsSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.mapAccum(
          (): ReadonlyMap<string, EngineJob> => new Map(),
          (jobs, event) => {
            const next = applyJobsEvent(jobs, event);
            return [next, [next]] as const;
          },
        ),
      ),
  }),
  exportStart: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:export:start",
    tag: WS_METHODS.exportStart,
  }),
  cancelJob: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:engine:cancel",
    tag: WS_METHODS.engineJobsCancel,
  }),
  exportStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:export:status",
    tag: WS_METHODS.exportStatus,
    isFinal: (status) => status !== null && status.state !== "running",
  }),
};

export type ProjectEditState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly snapshot: EditSnapshot }
  | { readonly _tag: "unavailable"; readonly message: string };

const LOADING: ProjectEditState = { _tag: "loading" };
const UNAVAILABLE_FALLBACK = "This project has no video edit, or its server is offline.";

function unavailableMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EditUnavailableError" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : UNAVAILABLE_FALLBACK;
}

const projectEditAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ProjectEditState => {
    if (ref === null || !get(environmentServerConfigsAtom).has(ref.environmentId)) return LOADING;
    const result = get(
      editEnvironment.edit({
        environmentId: ref.environmentId,
        input: { projectId: ref.projectId },
      }),
    );
    if (AsyncResult.isSuccess(result)) return { _tag: "ready", snapshot: result.value };
    if (AsyncResult.isFailure(result)) {
      return { _tag: "unavailable", message: unavailableMessage(result.cause) };
    }
    return LOADING;
  }).pipe(Atom.withLabel(`web-project-edit:${key}`));
});

/** The project's edit, kept live by `edit.subscribe`. */
export function useProjectEdit(ref: ScopedProjectRef): ProjectEditState {
  return useAtomValue(projectEditAtom(scopedProjectKey(ref)));
}

const NO_JOBS: ReadonlyMap<string, EngineJob> = new Map();

const environmentJobsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, EngineJob> => {
    if (!get(environmentServerConfigsAtom).has(environmentId)) return NO_JOBS;
    const result = get(editEnvironment.jobs({ environmentId, input: {} }));
    return AsyncResult.isSuccess(result) ? result.value : NO_JOBS;
  }).pipe(Atom.withLabel(`web-engine-jobs:${environmentId}`)),
);

const NO_STATUS = Atom.make(AsyncResult.initial<ExportStatus | null>()).pipe(
  Atom.withLabel("web-export-status:none"),
);

export interface ProjectExport {
  readonly job: EngineJob | null;
  /** `export.status` once the job has ended: its path, or the plain reason it failed. */
  readonly status: ExportStatus | null;
}

/**
 * The project's export: the one this panel started, or one still running from before the panel
 * mounted, with its outcome once it ends.
 */
export function useProjectExport(
  environmentId: EnvironmentId,
  projectId: string,
  startedJobId: string | null,
): ProjectExport {
  const jobs = useAtomValue(environmentJobsAtom(environmentId));
  const job = currentExportJob(jobs, projectId, startedJobId);
  const ended = job !== null && job.state !== "running";
  const result = useAtomValue(
    ended ? editEnvironment.exportStatus({ environmentId, input: { jobId: job.id } }) : NO_STATUS,
  );
  return { job, status: ended && AsyncResult.isSuccess(result) ? result.value : null };
}

export type PlayerSource =
  | { readonly kind: "edit" }
  | { readonly kind: "clip"; readonly mediaId: string };

const EDIT_SOURCE: PlayerSource = { kind: "edit" };

interface EditPlayerStore {
  /** What each project's player plays: the edit, or one clip picked in Assets. */
  readonly sourceByProjectKey: Readonly<Record<string, PlayerSource>>;
  setSource: (projectKey: string, source: PlayerSource) => void;
}

export const useEditPlayerStore = create<EditPlayerStore>()((set) => ({
  sourceByProjectKey: {},
  setSource: (projectKey, source) =>
    set((state) => ({ sourceByProjectKey: { ...state.sourceByProjectKey, [projectKey]: source } })),
}));

export function selectPlayerSource(
  sourceByProjectKey: Readonly<Record<string, PlayerSource>>,
  projectKey: string,
): PlayerSource {
  return sourceByProjectKey[projectKey] ?? EDIT_SOURCE;
}

/** Where each project's player is, so a new or remounted player opens there; never rendered. */
const positions = new Map<string, number>();

export function rememberPlayerFrame(projectKey: string, frame: number): void {
  positions.set(projectKey, frame);
}

export function rememberedPlayerFrame(projectKey: string): number {
  return positions.get(projectKey) ?? 0;
}

type FrameListener = (frame: number) => void;
const frameListeners = new Map<string, Set<FrameListener>>();

/**
 * @public The Transcript tab (S7V-030) follows the player with this.
 * Hears the edit frame on screen, every frame while playing; no React render per frame.
 */
export function subscribePlayerFrame(projectKey: string, listener: FrameListener): () => void {
  const listeners = frameListeners.get(projectKey) ?? new Set();
  frameListeners.set(projectKey, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) frameListeners.delete(projectKey);
  };
}

export function publishPlayerFrame(projectKey: string, frame: number): void {
  for (const listener of frameListeners.get(projectKey) ?? []) listener(frame);
}
