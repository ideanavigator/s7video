// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Thin handlers: resolve the caller's project and media (VideoProjectScope), call one engine or
// edit service method, map its errors. The Editor panel reaches the same services directly.
import {
  type EditDocument,
  type EditSnapshot,
  type EngineError,
  type TranscriptError,
  type EngineJob,
  type EngineJobId,
  type MediaLibraryError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import { editFileContents } from "../../../edit/EditProjectLayout.ts";
import * as SilenceCutService from "../../../edit/SilenceCutService.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ExportService from "../../../export/ExportService.ts";
import * as TranscriptService from "../../../transcript/TranscriptService.ts";
import * as MediaLibraryService from "../../../media/MediaLibraryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import {
  callerProject,
  resolveMedia,
  resolveSharedFile,
  type VideoProject,
} from "../../VideoProjectScope.ts";
import { VideoFrameToolkit, VideoStandardToolkit, type VideoToolkit } from "./tools.ts";

const DEFAULT_FRAME_WIDTH = 640;
const MAX_FRAME_WIDTH = 1920;
const CANCEL_WAIT = "5 seconds";
const MAX_JOB_WAIT_SECONDS = 30;

export const NO_ROOM_TO_COPY =
  "There is not enough free space to copy this file into the project. Ask the user to add it in Assets and choose to use the file where it is.";

/** The engine's messages are fixed text that tells the agent what to do next. */
const engineFailure = (error: EngineError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "rpc_error" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/** Refusals carry the scope's plain reason (not in this project); the rest the service's message. */
const transcriptFailure = (error: EngineError | TranscriptError) =>
  error._tag === "EngineError"
    ? engineFailure(error)
    : new OrchestratorMcpFailure({
        code: error.reason === "media_refused" ? "invalid_request" : "orchestration_error",
        message: error.message,
      });

const noSuchJob = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "There is no running video job with that id in this project.",
  });

export const KEEP_FORMAT =
  "keep is clip-frame ranges as video_transcript_read shows them, end exclusive: 9-30,60-90.";

export const KEEP_OVERLAP = "keep ranges overlap; give each pause once, for example 9-30,60-90.";

/** `"9-30, 60-90"` as frame ranges, or the plain reason it is not one. */
const parseKeep = (text: string) => {
  const ranges: Array<{ fromFrame: number; toFrame: number }> = [];
  for (const part of text.split(",")) {
    const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/u.exec(part);
    if (match === null) return { error: KEEP_FORMAT };
    const [fromFrame, toFrame] = [Number(match[1]), Number(match[2])];
    if (!(fromFrame < toFrame)) return { error: KEEP_FORMAT };
    ranges.push({ fromFrame, toFrame });
  }
  ranges.sort((a, b) => a.fromFrame - b.fromFrame);
  if (ranges.some((range, index) => index > 0 && range.fromFrame < ranges[index - 1]!.toFrame)) {
    return { error: KEEP_OVERLAP };
  }
  return { ranges };
};

/** The edit's length: the end of its last item on any track. */
export const editDurationFrames = (document: EditDocument) => {
  let end = 0;
  for (const track of document.tracks) {
    for (const item of track.items) end = Math.max(end, item.start + item.duration);
  }
  return end;
};

/** Running jobs are in the first event of a fresh subscription, its snapshot. */
const projectJobs = Effect.fn("VideoHandlers.projectJobs")(function* (project: VideoProject) {
  const engine = yield* EngineService.EngineService;
  const snapshot = yield* engine.subscribeJobs.pipe(Stream.runHead);
  const jobs =
    Option.isSome(snapshot) && snapshot.value.type === "snapshot" ? snapshot.value.jobs : [];
  return jobs.filter((job) => job.projectId === project.projectId);
});

/** The project's jobs that ended in the last few minutes, newest first (S7V-058). */
const finishedProjectJobs = Effect.fn("VideoHandlers.finishedProjectJobs")(function* (
  project: VideoProject,
) {
  const engine = yield* EngineService.EngineService;
  const recent = yield* engine.recentJobs;
  return recent.filter((job) => job.projectId === project.projectId).toReversed();
});

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const editSummary = ({ revision, document }: EditSnapshot) => {
  const items = document.tracks.reduce((total, track) => total + track.items.length, 0);
  const captions = document.tracks.some(
    (track) => track.kind === "caption" && track.items.length > 0,
  );
  return `revision ${revision}: ${count(items, "item")} on ${count(document.tracks.length, "track")}, ${count(editDurationFrames(document), "frame")}, captions ${captions ? "on" : "off"}`;
};

/**
 * Plan mode is read-only: a tool that changes the edit or writes into the project (import,
 * transcribe, silence cut, export, undo, redo) refuses a plan-mode thread. `actsAsCaller` only
 * refuses read-only clients and dead callers.
 */
const refusePlanMode = Effect.fn("VideoHandlers.refusePlanMode")(function* (action: string) {
  const caller = yield* loadCaller();
  if (caller.limits.interactionMode === "plan") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `This thread is in plan mode, so it cannot change the project. Switch out of plan mode to ${action}.`,
    });
  }
});

/**
 * S7V-063: undo keeps clips in Assets (S7V-059), so a step over an import can leave the edit as
 * it was. The step is still taken (one undo, one redo); the reply says nothing visible changed.
 */
const unchangedStep = (direction: "undo" | "redo", snapshot: EditSnapshot) => {
  const more = direction === "undo" ? snapshot.canUndo : snapshot.canRedo;
  const next =
    direction === "undo"
      ? more
        ? "Say undo again to go back further."
        : "There is nothing more to undo."
      : more
        ? "Say redo again to go forward."
        : "There is nothing more to redo.";
  return `Nothing on the timeline changed: that step only added or removed clips in Assets, and undo keeps clips there. ${next}`;
};

/** Undo and redo through the same service method as the edit.undo / edit.redo RPCs. */
const stepEdit = (direction: "undo" | "redo") =>
  McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      yield* refusePlanMode(direction);
      const project = yield* callerProject();
      const edits = yield* EditDocumentService.EditDocumentService;
      return yield* edits[direction](project.projectId).pipe(
        Effect.map((snapshot) => ({
          revision: snapshot.revision,
          message:
            editFileContents(snapshot.document) === editFileContents(project.snapshot.document)
              ? unchangedStep(direction, snapshot)
              : `${direction === "undo" ? "Undone" : "Redone"}. The edit is now ${editSummary(snapshot)}.`,
        })),
        Effect.catchTags({
          EditUnavailableError: (error) =>
            error.reason === "nothing-to-undo" || error.reason === "nothing-to-redo"
              ? Effect.succeed({ revision: project.snapshot.revision, message: error.explanation })
              : Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.explanation,
                  }),
                ),
        }),
      );
    }),
  );

const handlers = {
  // Always a copy: chat attachments live in the app's store, which may clean them up later.
  video_import: McpToolAccess.actsAsCaller(({ path }) =>
    Effect.gen(function* () {
      yield* refusePlanMode("import");
      const project = yield* callerProject();
      const { path: file, label } = yield* resolveSharedFile(project, path);
      const library = yield* MediaLibraryService.MediaLibraryService;
      const libraryFailure = (error: MediaLibraryError) =>
        new OrchestratorMcpFailure({
          code: error.reason === "edit-failed" ? "orchestration_error" : "invalid_request",
          message: error.explanation,
        });
      // A copy that would leave less than the free-space margin is refused, not made.
      const plan = yield* library
        .plan({ projectId: project.projectId, sourcePaths: [file] })
        .pipe(Effect.mapError(libraryFailure));
      if (plan.suggestedMode !== "copy") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: NO_ROOM_TO_COPY,
        });
      }
      const imported = yield* library
        .import({
          projectId: project.projectId,
          sourcePath: file,
          mode: "copy",
          origin: "agent",
          ...(label === undefined ? {} : { label }),
        })
        .pipe(Effect.mapError(libraryFailure));
      return {
        media: imported.mediaId,
        ...(imported.jobId === undefined ? {} : { jobId: imported.jobId }),
      };
    }),
  ),
  video_probe: McpToolAccess.readsAsCaller(({ media }) =>
    Effect.gen(function* () {
      const project = yield* callerProject();
      const scoped = yield* resolveMedia(project, media);
      const engine = yield* EngineService.EngineService;
      const probe = yield* engine.probe({ path: scoped.path }).pipe(Effect.mapError(engineFailure));
      return { ...probe, path: scoped.label, media: scoped.label };
    }),
  ),
  video_frame: McpToolAccess.readsAsCaller(({ media, frame, maxWidth }) =>
    Effect.gen(function* () {
      if (frame < 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "frame counts from 0.",
        });
      }
      const project = yield* callerProject();
      const scoped = yield* resolveMedia(project, media);
      const engine = yield* EngineService.EngineService;
      const fileSystem = yield* FileSystem.FileSystem;
      // A path the edit has not imported has no recorded rate, so the probe supplies it.
      const rate =
        scoped.fps ??
        (yield* engine.probe({ path: scoped.path }).pipe(Effect.mapError(engineFailure))).video
          ?.frameRate;
      if (rate === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${scoped.label} has no video to show a frame from.`,
        });
      }
      const grabbed = yield* engine
        .frame({
          path: scoped.path,
          frame,
          rate,
          maxWidth: Math.min(Math.max(maxWidth ?? DEFAULT_FRAME_WIDTH, 16), MAX_FRAME_WIDTH),
        })
        .pipe(Effect.mapError(engineFailure));
      const png = yield* fileSystem.readFile(grabbed.path).pipe(
        Effect.ensuring(fileSystem.remove(grabbed.path, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The video engine's frame could not be read. Try again.",
            }),
        ),
      );
      return {
        media: scoped.label,
        frame: grabbed.frame,
        rate: grabbed.rate,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(png).toString("base64"),
          width: grabbed.width,
          height: grabbed.height,
        },
      };
    }),
  ),
  video_edit_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { snapshot } = yield* callerProject();
      const { document } = snapshot;
      return {
        revision: snapshot.revision,
        fps: document.fps,
        canvas: document.canvas,
        durationFrames: editDurationFrames(document),
        tracks: document.tracks.map((track) => ({
          id: track.id,
          kind: track.kind,
          items: track.items.length,
        })),
        media: document.media.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          ...(entry.probe.durationFrames === undefined
            ? {}
            : { durationFrames: entry.probe.durationFrames }),
          ...(entry.label === undefined ? {} : { label: entry.label }),
        })),
        markers: document.markers.length,
        canUndo: snapshot.canUndo,
        canRedo: snapshot.canRedo,
      };
    }),
  ),
  video_job_status: McpToolAccess.readsAsCaller(({ jobId, waitSeconds }) =>
    Effect.gen(function* () {
      const project = yield* callerProject();
      const seconds = Math.min(waitSeconds ?? 0, MAX_JOB_WAIT_SECONDS);
      if (jobId === undefined || seconds <= 0) {
        const running = yield* projectJobs(project);
        const ended = yield* finishedProjectJobs(project);
        const jobs = [...running.filter((job) => !ended.some((e) => e.id === job.id)), ...ended];
        return { jobs: jobId === undefined ? jobs : jobs.filter((job) => job.id === jobId) };
      }
      // S7V-058: one call that waits saves the agent from polling a long transcription.
      const engine = yield* EngineService.EngineService;
      let latest: EngineJob | undefined;
      yield* engine.subscribeJobs.pipe(
        Stream.map((event) => {
          if (event.type === "snapshot") {
            latest = event.jobs.find(
              (job) => job.id === jobId && job.projectId === project.projectId,
            );
            return latest === undefined;
          }
          if (latest === undefined || event.job.id !== jobId) return false;
          latest = event.job;
          return event.job.state !== "running";
        }),
        Stream.filter((done) => done),
        Stream.runHead,
        Effect.timeoutOption(Duration.seconds(seconds)),
      );
      if (latest !== undefined) return { jobs: [latest] };
      // Not running: it may have ended before this call.
      const ended = (yield* finishedProjectJobs(project)).find((job) => job.id === jobId);
      return { jobs: ended === undefined ? [] : [ended] };
    }),
  ),
  // Reads-level access on purpose: it stops only the caller's own project's job, which a
  // plan-mode or read-only-sandbox thread may also need to do.
  video_job_cancel: McpToolAccess.readsAsCaller(({ jobId }) =>
    Effect.gen(function* () {
      const project = yield* callerProject();
      const engine = yield* EngineService.EngineService;
      // One subscription: its snapshot proves the job is this project's and still running, and
      // its later updates carry the job's final state, so none can slip between check and wait.
      const final = yield* engine.subscribeJobs.pipe(
        Stream.mapEffect((event) => {
          if (event.type === "snapshot") {
            const owned = event.jobs.some(
              (job) => job.id === jobId && job.projectId === project.projectId,
            );
            return owned
              ? engine.cancelJob(jobId).pipe(Effect.as(Option.none()))
              : Effect.fail(noSuchJob());
          }
          return Effect.succeed(
            event.job.id === jobId && event.job.state !== "running"
              ? Option.some(event.job.state)
              : Option.none(),
          );
        }),
        Stream.filter(Option.isSome),
        Stream.map((state) => state.value),
        Stream.runHead,
        Effect.timeoutOption(CANCEL_WAIT),
        Effect.map(Option.flatten),
      );
      return {
        jobId: jobId as EngineJobId,
        state: Option.getOrElse(final, () => "stopping" as const),
      };
    }),
  ),
  // Writes a file into the project, so plan-mode and read-only callers are refused.
  video_export: McpToolAccess.actsAsCaller(({ preset, captions }) =>
    Effect.gen(function* () {
      yield* refusePlanMode("export");
      const project = yield* callerProject();
      const exports = yield* ExportService.ExportService;
      return yield* exports
        .start({
          projectId: project.projectId,
          ...(preset === undefined ? {} : { preset }),
          ...(captions === undefined ? {} : { captions }),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "EngineError"
              ? engineFailure(error)
              : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
    }),
  ),
  // Acts on the environment: it loads a 4-6 GB model and writes the project's .s7cache, and the
  // matching transcribe.run RPC needs operate scope, so plan-mode and read-only callers are refused.
  video_transcribe: McpToolAccess.actsAsCaller(({ media }) =>
    Effect.gen(function* () {
      yield* refusePlanMode("transcribe");
      const project = yield* callerProject();
      const transcripts = yield* TranscriptService.TranscriptService;
      return yield* transcripts
        .start({ projectId: project.projectId, media })
        .pipe(Effect.mapError(transcriptFailure));
    }),
  ),
  video_transcript_read: McpToolAccess.readsAsCaller(({ media }) =>
    Effect.gen(function* () {
      const project = yield* callerProject();
      const transcripts = yield* TranscriptService.TranscriptService;
      const text = yield* transcripts
        .readText({ projectId: project.projectId, media })
        .pipe(Effect.mapError(transcriptFailure));
      if (text === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${media} has no transcript yet. Run video_transcribe first.`,
        });
      }
      return { text };
    }),
  ),
  video_undo: stepEdit("undo"),
  video_redo: stepEdit("redo"),
  // Writes the edit (one checkpoint), so plan-mode and read-only callers are refused.
  video_remove_silences: McpToolAccess.actsAsCaller(({ media, minGapSeconds, keep }) =>
    Effect.gen(function* () {
      yield* refusePlanMode("remove silences");
      const parsed = keep === undefined ? undefined : parseKeep(keep);
      if (parsed !== undefined && "error" in parsed) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: parsed.error,
        });
      }
      const ranges = parsed?.ranges;
      if (minGapSeconds !== undefined && (minGapSeconds <= 0 || minGapSeconds > 60)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "minGapSeconds is a pause length in seconds, above 0 and at most 60.",
        });
      }
      const project = yield* callerProject();
      const silences = yield* SilenceCutService.SilenceCutService;
      return yield* silences
        .removeSilences({
          projectId: project.projectId,
          ...(media === undefined ? {} : { media }),
          ...(minGapSeconds === undefined ? {} : { minGapSeconds }),
          ...(ranges === undefined ? {} : { keep: ranges }),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "EngineError"
              ? engineFailure(error)
              : new OrchestratorMcpFailure({
                  code:
                    error._tag === "SilenceCutError" || error._tag === "EditConflict"
                      ? "invalid_request"
                      : "orchestration_error",
                  message:
                    error._tag === "EditUnavailableError" ? error.explanation : error.message,
                }),
          ),
        );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof VideoToolkit.tools>;

export const layerStandard = McpToolAccess.toLayer(VideoStandardToolkit, {
  video_import: handlers.video_import,
  video_probe: handlers.video_probe,
  video_edit_read: handlers.video_edit_read,
  video_job_status: handlers.video_job_status,
  video_job_cancel: handlers.video_job_cancel,
  video_export: handlers.video_export,
  video_transcribe: handlers.video_transcribe,
  video_transcript_read: handlers.video_transcript_read,
  video_undo: handlers.video_undo,
  video_redo: handlers.video_redo,
  video_remove_silences: handlers.video_remove_silences,
});

export const layerFrame = McpToolAccess.toLayer(VideoFrameToolkit, {
  video_frame: handlers.video_frame,
});
