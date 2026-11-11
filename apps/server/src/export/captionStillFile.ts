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

import { openMediaFile } from "../assets/MediaFile.ts";
import * as ProjectService from "../project/ProjectService.ts";

const LOOK_NAME = /^[0-9a-f]{32}$/;
const STILL_NAME = /^[0-9a-f]{32}\.png$/;

/** A look folder name the engine could have written: nothing else is ever signed or served. */
export const isCaptionLookName = (folder: string): boolean => LOOK_NAME.test(folder);

/** The project's caption cache, as the engine is told to use it. */
export const captionCacheDir = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ".s7cache", "captions");

/**
 * One still of the project, opened from its expected real path with `openMediaFile` (no-follow,
 * identity re-checked), or null for a name that isn't the engine's, a removed project, or a link
 * on the way. The route streams that descriptor, so a link or FIFO swapped in later isn't read.
 */
export const openCaptionStill = Effect.fn("captionStillFile.openCaptionStill")(function* (
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
  const realRoot = yield* fileSystem
    .realPath(path.resolve(project.value.workspaceRoot))
    .pipe(Effect.orElseSucceed(() => null));
  if (realRoot === null) return null;
  // `openMediaFile` refuses it unless this is its real path: no part of the way is a link.
  const still = path.join(captionCacheDir(path, realRoot), folder, name);
  const file = yield* openMediaFile(still).pipe(Effect.orElseSucceed(() => null));
  return file === null ? null : { path: still, file };
});
