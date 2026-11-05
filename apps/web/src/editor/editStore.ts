// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Edit state for the Editor panel (S7V-029), keyed by project: every thread of a project shows the
 * same edit. The document comes from `edit.subscribe`; the player's place and what it plays live
 * in a small store; the playing frame goes to listeners (the transcript) without React state.
 * Transcripts (S7V-030) are cached per media and refetched when a transcription finishes.
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
  type ProjectId,
  type ScopedProjectRef,
  type Transcript,
  WS_METHODS,
} from "@t3tools/contracts";
import { Cause, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "../state/server";
import {
  acceptNewerSnapshot,
  adoptedExportJobId,
  applyJobsEvent,
  currentExportJob,
} from "./editStreams";

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
  transcribeRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:transcribe:run",
    tag: WS_METHODS.transcribeRun,
  }),
  modelsStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:transcribe:models-status",
    tag: WS_METHODS.transcribeModelsStatus,
  }),
  modelsDownload: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:transcribe:models-download",
    tag: WS_METHODS.transcribeModelsDownload,
  }),
  modelsDismiss: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:transcribe:models-dismiss",
    tag: WS_METHODS.transcribeModelsDismiss,
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

export const TRANSCRIBE_JOB_KIND = "transcribe";
export const MODELS_DOWNLOAD_JOB_KIND = "transcribe.models.download";

/** Counts the project's finished transcriptions, so a transcript refetches after the agent's too. */
const finishedTranscriptionsAtom = Atom.family((key: string) => {
  const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    let finished = 0;
    for (const job of get(environmentJobsAtom(environmentId)).values()) {
      if (
        job.kind === TRANSCRIBE_JOB_KIND &&
        job.projectId === projectId &&
        job.state === "succeeded"
      ) {
        finished += 1;
      }
    }
    return finished;
  }).pipe(Atom.withLabel(`web-finished-transcriptions:${key}`));
});

const transcriptQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:transcript:get",
  tag: WS_METHODS.transcriptGet,
  staleTimeMs: 5 * 60_000,
  refreshTrigger: ({ environmentId, input }) =>
    finishedTranscriptionsAtom(JSON.stringify([environmentId, input.projectId])),
});

export type MediaTranscriptState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly transcript: Transcript | null }
  | { readonly _tag: "error"; readonly message: string };

const TRANSCRIPT_LOADING: MediaTranscriptState = { _tag: "loading" };
const NO_TRANSCRIPT = Atom.make(AsyncResult.initial<{ transcript: Transcript | null }>()).pipe(
  Atom.withLabel("web-transcript:none"),
);

/** The cached transcript of one of the project's media, or null before it is transcribed. */
export function useMediaTranscript(
  ref: ScopedProjectRef,
  mediaId: string | null,
): MediaTranscriptState {
  const result = useAtomValue(
    mediaId === null
      ? NO_TRANSCRIPT
      : transcriptQuery({
          environmentId: ref.environmentId,
          input: { projectId: ref.projectId, media: mediaId },
        }),
  );
  if (AsyncResult.isSuccess(result)) return { _tag: "ready", transcript: result.value.transcript };
  if (AsyncResult.isFailure(result)) {
    const error = Cause.squash(result.cause);
    return {
      _tag: "error",
      message: error instanceof Error ? error.message : "The transcript can't be read right now.",
    };
  }
  return TRANSCRIPT_LOADING;
}

export interface TranscriptionJobs {
  /** A transcription of this project that is running now. */
  readonly transcribe: EngineJob | null;
  /** The speech model download, while it runs. */
  readonly download: EngineJob | null;
}

/** This project's running transcription and the model download, from the jobs stream. */
export function useTranscriptionJobs(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): TranscriptionJobs {
  const jobs = useAtomValue(environmentJobsAtom(environmentId));
  let transcribe: EngineJob | null = null;
  let download: EngineJob | null = null;
  for (const job of jobs.values()) {
    if (job.state !== "running") continue;
    if (job.kind === TRANSCRIBE_JOB_KIND && job.projectId === projectId) transcribe = job;
    if (job.kind === MODELS_DOWNLOAD_JOB_KIND) download = job;
  }
  return { transcribe, download };
}

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
  const [adoptedJobId, setAdoptedJobId] = useState<string | null>(null);
  const job = currentExportJob(jobs, projectId, startedJobId ?? adoptedJobId);
  const adopt = adoptedExportJobId(adoptedJobId, startedJobId, job);
  if (adopt !== adoptedJobId) setAdoptedJobId(adopt);
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

const seekListeners = new Map<string, Set<FrameListener>>();

/** The project's player seeks to edit frame `frame` (a click in the transcript). */
export function requestPlayerSeek(projectKey: string, frame: number): void {
  for (const listener of seekListeners.get(projectKey) ?? []) listener(frame);
}

/** The player hears seek requests for its project while it is mounted. */
export function subscribePlayerSeek(projectKey: string, listener: FrameListener): () => void {
  const listeners = seekListeners.get(projectKey) ?? new Set();
  seekListeners.set(projectKey, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) seekListeners.delete(projectKey);
  };
}
