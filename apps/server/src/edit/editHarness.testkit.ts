// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Test helpers inspect the repo with plain git and fs calls.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import * as EditHistoryService from "./EditHistoryService.ts";
import * as EditProjectLayout from "./EditProjectLayout.ts";
import * as EditSnapshotStore from "./EditSnapshotStore.ts";
import * as LegacyEditHistory from "./LegacyEditHistory.ts";

/**
 * Flip `failTempRename` to simulate a crash between the temp write and the rename; set
 * `failTempRenameOf` to fail only the temp file of that one file (for example "project.json").
 */
export interface EditFaults {
  failTempRename: boolean;
  failTempRenameOf?: string;
}

export const layerFaultyFileSystem = (faults: EditFaults) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fileSystem) =>
      FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          from.endsWith(".tmp") &&
          (faults.failTempRename ||
            (faults.failTempRenameOf !== undefined &&
              from.includes(`/.${faults.failTempRenameOf}.`)))
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  description: "simulated crash before rename",
                }),
              )
            : fileSystem.rename(from, to),
      }),
    ),
  );

const layerRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer));

/** Counts every child process started through Effect's spawner (git included). */
export interface SpawnCounter {
  count: number;
}

const layerCountingSpawner = (counter: SpawnCounter) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      ChildProcessSpawner.make((command) => {
        counter.count += 1;
        return spawner.spawn(command);
      }),
    ),
  );

export interface EditTestOptions {
  /** How an old git history is read; defaults to never looking. */
  readonly legacy?: Layer.Layer<
    LegacyEditHistory.LegacyEditHistory,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | Crypto.Crypto
    | ServerConfig.ServerConfig
  >;
  readonly spawns?: SpawnCounter;
}

/**
 * The real edit and history services in a temp home. Project creation (`ManagedProjectFolders`)
 * still runs git; the edit history never does (S7V-051).
 */
export const layerEditTest = (
  baseDir: string,
  faults: EditFaults = { failTempRename: false },
  options: EditTestOptions = {},
) =>
  Layer.mergeAll(
    EditDocumentService.layer.pipe(
      Layer.provide(EditProjectLayout.layer),
      Layer.provideMerge(
        EditHistoryService.layer.pipe(
          Layer.provide(options.legacy ?? LegacyEditHistory.layerNone),
          Layer.provideMerge(EditSnapshotStore.layer),
        ),
      ),
      Layer.provide(layerFaultyFileSystem(faults)),
    ),
    ManagedProjectFolders.layer,
    EditProjectLayout.layer,
    ProjectFaviconResolver.layer.pipe(Layer.provide(T3ProjectFileLoader.layer)),
  ).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(
      ProjectEnrichmentService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
            Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
              invalidate: () => Effect.void,
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(
      GitWorkflow.layer.pipe(
        Layer.provide(layerRegistry),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
      ),
    ),
    Layer.provideMerge(layerRegistry),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(
      options.spawns === undefined ? Layer.empty : layerCountingSpawner(options.spawns),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** `.s7history/log.json` as written, or null when there is none. */
export const historyLog = (root: string): EditSnapshotStore.HistoryLog | null => {
  const file = NodePath.join(root, EditProjectLayout.HISTORY_DIR, "log.json");
  return NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : null;
};

/** The object files under `.s7history/objects/`. */
export const historyObjects = (root: string) => {
  const folder = NodePath.join(root, EditProjectLayout.HISTORY_DIR, "objects");
  return NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder).toSorted() : [];
};

export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  ).toString();

export const isIgnored = (cwd: string, file: string) => {
  try {
    git(cwd, "check-ignore", "--quiet", "--no-index", "--", file);
    return true;
  } catch {
    return false;
  }
};
