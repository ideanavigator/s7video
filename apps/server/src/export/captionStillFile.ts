// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Where the player's caption stills live, and the only files the asset route serves for them
 * (S7V-079): `<project>/.s7cache/captions/<look>/<text>.png`, both names 32 hex digits, as the
 * engine's `captions.render` names them (`methods/captions.py`).
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";

const LOOK_NAME = /^[0-9a-f]{32}$/;
const STILL_NAME = /^[0-9a-f]{32}\.png$/;

/** A look folder name the engine could have written: nothing else is ever signed or served. */
export const isCaptionLookName = (folder: string): boolean => LOOK_NAME.test(folder);

/** The project's caption cache, as the engine is told to use it. */
export const captionCacheDir = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ".s7cache", "captions");

/**
 * The real path of one still of the project, or null. Refused: a name that isn't the engine's
 * (so no `..`, separators, encodings or other files), a project that no longer exists, and a
 * link anywhere on the way. Both the named path and the real path must be the same place under
 * the project's own `.s7cache/captions/`, as `WorkspaceFileSystem.isInGitFolder` checks.
 */
export const resolveCaptionStill = Effect.fn("captionStillFile.resolveCaptionStill")(function* (
  projectId: ProjectId,
  folder: string,
  name: string,
) {
  if (!isCaptionLookName(folder) || !STILL_NAME.test(name)) return null;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
  if (Option.isNone(project)) return null;
  const root = path.resolve(project.value.workspaceRoot);
  const named = path.join(captionCacheDir(path, root), folder, name);
  const [realRoot, realStill] = yield* Effect.all([
    fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => null)),
    fileSystem.realPath(named).pipe(Effect.orElseSucceed(() => null)),
  ]);
  if (realRoot === null || realStill === null) return null;
  // Equal only when no part of `.s7cache/captions/<look>/<name>` is a link.
  if (realStill !== path.join(captionCacheDir(path, realRoot), folder, name)) return null;
  const info = yield* fileSystem.stat(realStill).pipe(Effect.orElseSucceed(() => null));
  return info?.type === "File" ? realStill : null;
});
