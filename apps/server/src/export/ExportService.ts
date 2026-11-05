// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Export (S7V-028): renders a project's edit to `exports/<project>-<yyyymmdd-hhmm>.mp4` as an
// engine job. `start` answers with the job id at once; progress and cancel are the engine job's
// (`engine.jobs.subscribe`, `engine.jobs.cancel`), and `status` gives the outcome. The Export
// button (S7V-029) and the agent's `video_export` tool (S7V-023) both call this service. With
// captions on and no caption items, the clips' cached transcripts give the captions (S7V-046).
import {
  type EditDocument,
  EditUnavailableError,
  type EngineError,
  type EngineJobId,
  type ExportPreset,
  ExportRenderResult,
  ExportStartError,
  type ExportStartInput,
  type ExportStartResult,
  type ExportStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";

export class ExportService extends Context.Service<
  ExportService,
  {
    readonly start: (
      input: ExportStartInput,
    ) => Effect.Effect<ExportStartResult, EditUnavailableError | ExportStartError | EngineError>;
    /** The export behind an engine job, or null when this server did not start it. */
    readonly status: (jobId: EngineJobId) => Effect.Effect<ExportStatus | null>;
    /** Waits for the export to finish and gives its final status (null as for `status`). */
    readonly wait: (jobId: EngineJobId) => Effect.Effect<ExportStatus | null>;
  }
>()("t3/export/ExportService") {}

const EXPORTS_DIR = "exports";
const PRESET_CANVAS: Record<ExportPreset, { readonly width: number; readonly height: number }> = {
  "reel-9x16": { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};
// Finished exports are kept for `status` until this many newer ones exist.
const KEEP_FINISHED = 50;

/** `My Reel #2` → `my-reel-2`; empty or symbols-only titles become `export`. */
export const exportSlug = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "") || "export";

/**
 * The media whose transcripts caption the export: those on the first video track (the one the
 * engine renders) that have sound, when captions are on and no caption track has items. A clip
 * without audio cannot be transcribed, so it gets no captions rather than blocking the export.
 */
export const transcriptMediaFor = (document: EditDocument, captions: boolean) => {
  if (!captions) return [];
  if (document.tracks.some((track) => track.kind === "caption" && track.items.length > 0)) {
    return [];
  }
  const video = document.tracks.find((track) => track.kind === "video");
  const audible = new Set(
    document.media.filter((entry) => entry.probe.hasAudio).map((entry) => entry.id),
  );
  return [...new Set(video?.items.map((item) => item.media) ?? [])].filter((media) =>
    audible.has(media),
  );
};

/** Local date and time to the minute, `yyyymmdd-hhmm`. */
export const exportStamp = (millis: number) => {
  const parts = DateTime.toParts(
    DateTime.makeZonedUnsafe(millis, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const two = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}${two(parts.month)}${two(parts.day)}-${two(parts.hour)}${two(parts.minute)}`;
};

const make = Effect.gen(function* () {
  const engine = yield* EngineService.EngineService;
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const transcripts = yield* TranscriptService.TranscriptService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const exports = new Map<EngineJobId, ExportStatus>();
  const finished = new Map<EngineJobId, Deferred.Deferred<ExportStatus>>();
  // Names handed out while their file is still being written (as `.part`).
  const reserved = new Set<string>();
  // Picking a free name yields on file checks, so pick and reserve under one permit: two starts
  // in the same minute (the button and the agent) never get the same file.
  const naming = yield* Semaphore.make(1);

  const remember = (status: ExportStatus) =>
    Effect.suspend(() => {
      exports.delete(status.jobId);
      exports.set(status.jobId, status);
      let done = finished.get(status.jobId);
      if (done === undefined) {
        done = Deferred.makeUnsafe<ExportStatus>();
        finished.set(status.jobId, done);
      }
      const ended = [...exports.values()].filter((entry) => entry.state !== "running");
      for (const entry of ended.slice(0, Math.max(0, ended.length - KEEP_FINISHED))) {
        exports.delete(entry.jobId);
        finished.delete(entry.jobId);
      }
      return status.state === "running" ? Effect.void : Deferred.succeed(done, status);
    }).pipe(Effect.asVoid);

  const reserveName = (folder: string, base: string) =>
    naming.withPermit(
      Effect.gen(function* () {
        for (let index = 1; ; index += 1) {
          const name = index === 1 ? `${base}.mp4` : `${base}-${index}.mp4`;
          const file = path.join(folder, name);
          if (reserved.has(file)) continue;
          const taken = yield* Effect.all([
            fileSystem.exists(file),
            fileSystem.exists(`${file}.part`),
          ]).pipe(Effect.orElseSucceed(() => [true, true] as const));
          if (!taken[0] && !taken[1]) {
            reserved.add(file);
            return { name, file };
          }
        }
      }),
    );

  const start: ExportService["Service"]["start"] = Effect.fn("ExportService.start")(
    function* (input) {
      const snapshot = yield* edits.read(input.projectId);
      const project = yield* projects
        .getById(input.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(project)) {
        return yield* new EditUnavailableError({
          projectId: input.projectId,
          reason: "unknown-project",
          explanation: "This project no longer exists.",
        });
      }
      const captions = input.captions ?? true;
      // Read before anything is written, so a missing transcript leaves no file behind.
      const captionWords = yield* Effect.forEach(
        transcriptMediaFor(snapshot.document, captions),
        (media) =>
          transcripts.get({ projectId: input.projectId, media }).pipe(
            Effect.mapError(
              (cause) =>
                new ExportStartError({
                  projectId: input.projectId,
                  reason: "no-transcript",
                  cause,
                }),
            ),
            Effect.flatMap((transcript) =>
              transcript === null
                ? Effect.fail(
                    new ExportStartError({ projectId: input.projectId, reason: "no-transcript" }),
                  )
                : Effect.succeed({
                    media,
                    fps: transcript.fps,
                    words: transcript.words.map(({ text, startFrame, endFrame }) => ({
                      text,
                      startFrame,
                      endFrame,
                    })),
                  }),
            ),
          ),
      );
      const root = path.resolve(project.value.workspaceRoot);
      const folder = path.join(root, EXPORTS_DIR);
      yield* fileSystem
        .makeDirectory(folder, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ExportStartError({ projectId: input.projectId, reason: "exports-folder", cause }),
          ),
        );
      const { name, file } = yield* reserveName(
        folder,
        `${exportSlug(project.value.title)}-${exportStamp(yield* Clock.currentTimeMillis)}`,
      );
      const relative = `${EXPORTS_DIR}/${name}`;
      const started = yield* Deferred.make<EngineJobId, EngineError>();
      let jobId: EngineJobId | undefined;
      const entry = (id: EngineJobId) => ({
        jobId: id,
        projectId: input.projectId,
        path: relative,
      });
      const finish = (exit: Exit.Exit<ExportRenderResult, EngineError>) =>
        Effect.suspend(() => {
          reserved.delete(file);
          if (jobId === undefined) {
            return Exit.isFailure(exit) ? Deferred.failCause(started, exit.cause) : Effect.void;
          }
          if (Exit.isSuccess(exit)) {
            return remember({
              ...entry(jobId),
              state: "succeeded",
              result: {
                path: relative,
                durationFrames: exit.value.durationFrames,
                fps: exit.value.fps,
                width: exit.value.width,
                height: exit.value.height,
                captions: exit.value.captions,
                lufs: exit.value.lufs,
                truePeak: exit.value.truePeak,
              },
            });
          }
          const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
          if (failure?.reason === "cancelled")
            return remember({ ...entry(jobId), state: "cancelled" });
          return remember({
            ...entry(jobId),
            state: "failed",
            message: failure?.message ?? "The export stopped unexpectedly. Try again.",
          });
        });
      const job = engine
        .runJob({
          kind: "export",
          method: "export.render",
          projectId: input.projectId,
          params: {
            edit: snapshot.document,
            projectDir: root,
            outputPath: file,
            captions,
            ...(captionWords.length > 0 ? { transcripts: captionWords } : {}),
            ...(input.preset ? { canvas: PRESET_CANVAS[input.preset] } : {}),
          },
          success: ExportRenderResult,
          onStart: (id) =>
            Effect.suspend(() => {
              jobId = id;
              return remember({ ...entry(id), state: "running" });
            }).pipe(Effect.andThen(Deferred.succeed(started, id))),
        })
        .pipe(Effect.onExit(finish));
      // The render outlives the request that started it; it stops with the server or on cancel.
      yield* job.pipe(Effect.forkIn(scope));
      const id = yield* Deferred.await(started);
      return { jobId: id, path: relative };
    },
  );

  const status: ExportService["Service"]["status"] = (jobId) =>
    Effect.sync(() => exports.get(jobId) ?? null);

  const wait: ExportService["Service"]["wait"] = (jobId) =>
    Effect.suspend(() => {
      const done = finished.get(jobId);
      return done === undefined ? Effect.succeed(null) : Deferred.await(done);
    });

  return ExportService.of({ start, status, wait });
});

export const layer = Layer.effect(ExportService, make);
