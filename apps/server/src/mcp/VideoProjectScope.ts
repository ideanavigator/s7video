// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Which media a video tool may touch: only the calling thread's own edit project. A tool takes a
 * media id from that project's `edit.json`, or a path whose real path (symlinks resolved) is inside
 * the project folder or is a reference `edit.json` records. Everything else is refused before the
 * engine is called.
 */
import {
  type EditRational,
  type EditSnapshot,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const NOT_IN_PROJECT = "That file is not part of this project. Import it first.";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const notInProject = () => failure("invalid_request", NOT_IN_PROJECT);

export interface VideoProject {
  readonly projectId: ProjectId;
  /** The project folder's real path. */
  readonly root: string;
  readonly snapshot: EditSnapshot;
}

export interface ScopedMedia {
  /** The real path the engine reads. */
  readonly path: string;
  /** The path shown back to the agent: project-relative when inside the project. */
  readonly label: string;
  /** The media's frame rate as `edit.json` recorded it at import, when it is a recorded media. */
  readonly fps: EditRational | undefined;
}

/** The calling thread's edit project and its current edit. */
export const callerProject = Effect.fn("VideoProjectScope.callerProject")(function* () {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("video").pipe(
    Effect.mapError(() =>
      failure(
        "capability_denied",
        "Video tools work only in a video project. Open or create a video project and start a new thread there.",
      ),
    ),
  );
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const edits = yield* EditDocumentService.EditDocumentService;
  const fileSystem = yield* FileSystem.FileSystem;
  const unavailable = () => failure("orchestration_error", "Could not look up this project.");
  const shell = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (shell === null) return yield* failure("thread_not_found", "This thread no longer exists.");
  const project = yield* projects.getById(shell.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) return yield* unavailable();
  const root = yield* fileSystem
    .realPath(project.value.workspaceRoot)
    .pipe(Effect.mapError(() => failure("orchestration_error", "The project folder is missing.")));
  const snapshot = yield* edits
    .read(shell.projectId)
    .pipe(Effect.mapError((error) => failure("orchestration_error", error.explanation)));
  return { projectId: shell.projectId, root, snapshot } satisfies VideoProject;
});

/** Resolves `media` (a media id or a path) to a real file this project may use, or refuses it. */
export const resolveMedia = Effect.fn("VideoProjectScope.resolveMedia")(function* (
  project: VideoProject,
  media: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root } = project;
  const recorded = project.snapshot.document.media;
  const isInside = (candidate: string) =>
    candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const realPathOf = (candidate: string) =>
    fileSystem.realPath(candidate).pipe(Effect.option, Effect.map(Option.getOrUndefined));

  const byId = recorded.find((entry) => entry.id === media);
  const requested =
    byId === undefined
      ? path.resolve(root, media)
      : byId.path !== undefined
        ? path.resolve(root, byId.path)
        : byId.reference;
  if (requested === undefined) return yield* notInProject();
  const real = yield* realPathOf(requested);
  if (real === undefined) {
    // Say nothing about files outside the project, not even whether they exist.
    if (byId === undefined && !isInside(requested)) return yield* notInProject();
    return yield* failure(
      "invalid_request",
      byId === undefined
        ? `There is no file at ${media} in this project.`
        : `The file for ${media} is missing. Import it again.`,
    );
  }

  // A recorded `path` must stay inside the project; a recorded `reference` may be anywhere.
  const allowed =
    isInside(real) ||
    (byId?.path === undefined &&
      (yield* Effect.forEach(
        recorded.filter((entry) => entry.reference !== undefined),
        (entry) => realPathOf(entry.reference!),
      )).includes(real));
  if (!allowed) return yield* notInProject();

  const info = yield* fileSystem.stat(real).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") {
    return yield* failure("invalid_request", `${media} is not a media file.`);
  }
  return {
    path: real,
    label: byId?.id ?? (isInside(real) ? path.relative(root, real) : real),
    fps: byId?.probe.fps,
  } satisfies ScopedMedia;
});
