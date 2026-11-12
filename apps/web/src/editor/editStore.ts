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
  type CaptionPresetsResult,
  type CaptionStillsResult,
  type EditDocument,
  type EditSnapshot,
  type EditVersion,
  type EngineJob,
  type EnvironmentId,
  type ExportStatus,
  type ProjectId,
  type ScopedProjectRef,
  type Transcript,
  type TranscribeModelsStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import { Cause, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { captionStillsSignature } from "./captionStills";
import { acceptNewerSnapshot, applyJobsEvent, followExportJob } from "./editStreams";

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
  /** Timeline gestures (S7V-034): one batch per gesture, with the revision it started from. */
  apply: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:apply",
    tag: WS_METHODS.editApply,
  }),
  undo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:undo",
    tag: WS_METHODS.editUndo,
  }),
  redo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:redo",
    tag: WS_METHODS.editRedo,
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
  versionGet: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:version-get",
    tag: WS_METHODS.editVersionGet,
  }),
  versionTag: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:version-tag",
    tag: WS_METHODS.editVersionTag,
  }),
  versionRestore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:version-restore",
    tag: WS_METHODS.editVersionRestore,
  }),
  versionDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:version-delete",
    tag: WS_METHODS.editVersionDelete,
  }),
  historyClean: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:history-clean",
    tag: WS_METHODS.editHistoryClean,
  }),
  historyDismiss: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:edit:history-dismiss",
    tag: WS_METHODS.editHistoryDismiss,
  }),
  /** The look picker (S7V-037): one change and one undo, adding captions when there are none. */
  setCaptionStyle: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:captions:set-style",
    tag: WS_METHODS.captionsSetStyle,
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

/**
 * Whether the project is a video project: its edit loads (S7V-076). A project without one fails
 * fast with `not-an-edit-project`; null (a draft, no project) subscribes to nothing.
 */
export function useIsVideoProject(ref: ScopedProjectRef | null): boolean {
  return useAtomValue(projectEditAtom(ref === null ? "" : scopedProjectKey(ref)))._tag === "ready";
}

/** The edit as last read, for a click handler; loading unless something keeps it subscribed. */
export function readProjectEdit(ref: ScopedProjectRef): ProjectEditState {
  return appAtomRegistry.get(projectEditAtom(scopedProjectKey(ref)));
}

/** Bumped after a tag or delete here, which changes the list but not the edit. */
const versionsBumpAtom = Atom.family((_key: string) => Atom.make(0).pipe(Atom.keepAlive));

/** Any change to the edit, from any chat or the Editor, refetches the version list (S7V-069). */
const versionsTriggerAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const edit = get(projectEditAtom(key));
    const at = edit._tag === "ready" ? `${edit.snapshot.revision}:${edit.snapshot.version}` : "";
    return `${at}:${get(versionsBumpAtom(key))}`;
  }).pipe(Atom.withLabel(`web-edit-versions-trigger:${key}`)),
);

const versionsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:edit:versions",
  tag: WS_METHODS.editVersions,
  refreshTrigger: ({ environmentId, input }) =>
    versionsTriggerAtom(scopedProjectKey({ environmentId, projectId: input.projectId })),
});

export type ProjectVersionsState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly versions: ReadonlyArray<EditVersion> }
  | { readonly _tag: "unavailable"; readonly message: string };

const VERSIONS_LOADING: ProjectVersionsState = { _tag: "loading" };

/** The project's versions, newest first, refetched whenever its edit changes. */
export function useProjectVersions(ref: ScopedProjectRef): ProjectVersionsState {
  const result = useAtomValue(
    versionsQuery({ environmentId: ref.environmentId, input: { projectId: ref.projectId } }),
  );
  if (AsyncResult.isSuccess(result)) return { _tag: "ready", versions: result.value.versions };
  if (AsyncResult.isFailure(result)) {
    return { _tag: "unavailable", message: unavailableMessage(result.cause) };
  }
  return VERSIONS_LOADING;
}

export function refreshProjectVersions(ref: ScopedProjectRef): void {
  const bump = versionsBumpAtom(scopedProjectKey(ref));
  appAtomRegistry.set(bump, appAtomRegistry.get(bump) + 1);
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

/** Refetches the caption stills only when the captions' look or timing changes (S7V-075). */
const captionStillsTriggerAtom = Atom.family((key: string) => {
  const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    const edit = get(
      projectEditAtom(scopedProjectKey({ environmentId, projectId: projectId as ProjectId })),
    );
    const transcriptions = get(finishedTranscriptionsAtom(key));
    return edit._tag === "ready"
      ? captionStillsSignature(edit.snapshot.document, transcriptions)
      : "";
  }).pipe(Atom.withLabel(`web-caption-stills-trigger:${key}`));
});

const captionStillsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:captions:stills",
  tag: WS_METHODS.captionsStills,
  refreshTrigger: ({ environmentId, input }) =>
    captionStillsTriggerAtom(JSON.stringify([environmentId, input.projectId])),
});

/** The looks' previews are drawn at the edit's canvas, so they change only with its size. */
const captionPresetsTriggerAtom = Atom.family((key: string) => {
  const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    const edit = get(
      projectEditAtom(scopedProjectKey({ environmentId, projectId: projectId as ProjectId })),
    );
    if (edit._tag !== "ready") return "";
    const { width, height } = edit.snapshot.document.canvas;
    return `${width}x${height}`;
  }).pipe(Atom.withLabel(`web-caption-presets-trigger:${key}`));
});

const captionPresetsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:captions:presets",
  tag: WS_METHODS.captionsPresets,
  refreshTrigger: ({ environmentId, input }) =>
    captionPresetsTriggerAtom(JSON.stringify([environmentId, input.projectId])),
});

/** Each caption look's name and preview, or null while they load or can't be read. */
export function useCaptionPresets(ref: ScopedProjectRef): CaptionPresetsResult | null {
  const result = useAtomValue(
    captionPresetsQuery({ environmentId: ref.environmentId, input: { projectId: ref.projectId } }),
  );
  const value = AsyncResult.value(result);
  return value._tag === "None" ? null : value.value;
}

export type CaptionStillsState =
  | { readonly _tag: "none" }
  /** `updating`: new stills are being drawn; these are the previous ones until they arrive. */
  | { readonly _tag: "ready"; readonly stills: CaptionStillsResult; readonly updating: boolean };

const NO_CAPTION_STILLS: CaptionStillsState = { _tag: "none" };

/** The edit's caption stills, drawn by the export's renderer, for the player's overlay. */
export function useCaptionStills(ref: ScopedProjectRef): CaptionStillsState {
  const result = useAtomValue(
    captionStillsQuery({ environmentId: ref.environmentId, input: { projectId: ref.projectId } }),
  );
  const value = AsyncResult.value(result);
  if (value._tag === "None") return NO_CAPTION_STILLS;
  return { _tag: "ready", stills: value.value, updating: result.waiting };
}

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

/** This project's running transcription (none without a project) and the model download. */
export function useTranscriptionJobs(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): TranscriptionJobs {
  const jobs = useAtomValue(environmentJobsAtom(environmentId));
  let transcribe: EngineJob | null = null;
  let download: EngineJob | null = null;
  for (const job of jobs.values()) {
    if (job.state !== "running") continue;
    if (job.kind === TRANSCRIBE_JOB_KIND && projectId !== null && job.projectId === projectId)
      transcribe = job;
    if (job.kind === MODELS_DOWNLOAD_JOB_KIND) download = job;
  }
  return { transcribe, download };
}

/** Bumped after the user answers the model question, so every reader of the status refetches. */
const modelsAnswerRevisionAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(0).pipe(Atom.keepAlive),
);

const modelsStatusTriggerAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    let ended = 0;
    for (const job of get(environmentJobsAtom(environmentId)).values()) {
      if (job.kind === MODELS_DOWNLOAD_JOB_KIND && job.state !== "running") ended += 1;
    }
    return `${get(modelsAnswerRevisionAtom(environmentId))}:${ended}`;
  }).pipe(Atom.withLabel(`web-models-status-trigger:${environmentId}`)),
);

const modelsStatusQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:transcribe:models-status-query",
  tag: WS_METHODS.transcribeModelsStatus,
  refreshTrigger: ({ environmentId }) => modelsStatusTriggerAtom(environmentId),
});

export type SpeechModelStatusState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "ready"; readonly status: TranscribeModelsStatus };

/** The speech model's status on this server, refetched when a download ends. */
export function useSpeechModelStatusState(environmentId: EnvironmentId): SpeechModelStatusState {
  const result = useAtomValue(modelsStatusQuery({ environmentId, input: {} }));
  if (AsyncResult.isSuccess(result)) return { _tag: "ready", status: result.value };
  return AsyncResult.isFailure(result) ? { _tag: "unavailable" } : { _tag: "loading" };
}

/** The status once known; null while loading or when the engine can't answer. */
export function useSpeechModelStatus(environmentId: EnvironmentId): TranscribeModelsStatus | null {
  const state = useSpeechModelStatusState(environmentId);
  return state._tag === "ready" ? state.status : null;
}

export function refreshSpeechModelStatus(environmentId: EnvironmentId): void {
  const revision = modelsAnswerRevisionAtom(environmentId);
  appAtomRegistry.set(revision, appAtomRegistry.get(revision) + 1);
}

export const anySpeechModelReady = (status: TranscribeModelsStatus) =>
  status.profiles.default.ready || status.profiles.light.ready;

interface SpeechModelRequestStore {
  /** Servers whose agent asked for the missing model since the user last answered (S7V-067). */
  readonly requested: Readonly<Record<string, true>>;
  request: (environmentId: EnvironmentId) => void;
  clear: (environmentId: EnvironmentId) => void;
}

export const useSpeechModelRequests = create<SpeechModelRequestStore>()((set) => ({
  requested: {},
  request: (environmentId) =>
    set((state) =>
      state.requested[environmentId]
        ? state
        : { requested: { ...state.requested, [environmentId]: true } },
    ),
  clear: (environmentId) =>
    set((state) => {
      if (!state.requested[environmentId]) return state;
      const { [environmentId]: _cleared, ...rest } = state.requested;
      return { requested: rest };
    }),
}));

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
  // An adoption belongs to the export started here when it was made; a new start replaces it.
  const [adoption, setAdoption] = useState<{
    readonly startedJobId: string | null;
    readonly jobId: string;
  } | null>(null);
  const adoptedJobId = adoption?.startedJobId === startedJobId ? adoption.jobId : null;
  const { job, adoptedJobId: adopt } = followExportJob(jobs, projectId, startedJobId, adoptedJobId);
  if (adopt !== adoptedJobId) setAdoption(adopt === null ? null : { startedJobId, jobId: adopt });
  const ended = job !== null && job.state !== "running";
  const result = useAtomValue(
    ended ? editEnvironment.exportStatus({ environmentId, input: { jobId: job.id } }) : NO_STATUS,
  );
  return { job, status: ended && AsyncResult.isSuccess(result) ? result.value : null };
}

export type PlayerSource =
  | { readonly kind: "edit" }
  | { readonly kind: "clip"; readonly mediaId: string }
  /** A saved version, read only (S7V-069): nothing is written while it plays. */
  | { readonly kind: "version"; readonly n: number; readonly document: EditDocument };

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
