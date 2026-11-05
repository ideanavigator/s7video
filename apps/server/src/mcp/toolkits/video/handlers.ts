// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Thin handlers: resolve the caller's project and media (VideoProjectScope), call one engine or
// edit service method, map its errors. The Editor panel reaches the same services directly.
import {
  type EditDocument,
  type EngineError,
  type EngineJobId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EngineService from "../../../engine/EngineService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerProject, resolveMedia, type VideoProject } from "../../VideoProjectScope.ts";
import { VideoFrameToolkit, VideoStandardToolkit, type VideoToolkit } from "./tools.ts";

const DEFAULT_FRAME_WIDTH = 640;
const MAX_FRAME_WIDTH = 1920;
const CANCEL_WAIT = "5 seconds";

/** The engine's messages are fixed text that tells the agent what to do next. */
const engineFailure = (error: EngineError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "rpc_error" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const noSuchJob = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "There is no running video job with that id in this project.",
  });

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

const handlers = {
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
  video_job_status: McpToolAccess.readsAsCaller(({ jobId }) =>
    Effect.gen(function* () {
      const jobs = yield* projectJobs(yield* callerProject());
      return { jobs: jobId === undefined ? jobs : jobs.filter((job) => job.id === jobId) };
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
} satisfies McpToolAccess.Handlers<typeof VideoToolkit.tools>;

export const layerStandard = McpToolAccess.toLayer(VideoStandardToolkit, {
  video_probe: handlers.video_probe,
  video_edit_read: handlers.video_edit_read,
  video_job_status: handlers.video_job_status,
  video_job_cancel: handlers.video_job_cancel,
});

export const layerFrame = McpToolAccess.toLayer(VideoFrameToolkit, {
  video_frame: handlers.video_frame,
});
