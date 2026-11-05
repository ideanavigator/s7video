// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Test helpers inspect the repo with plain git and fs calls.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as NodeChildProcess from "node:child_process";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
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

/**
 * Flip `failTempRename` to simulate a crash between the temp write and the rename; set
 * `failTempRenameOf` to fail only the temp file of that one file (for example "project.json").
 */
export interface EditFaults {
  failTempRename: boolean;
  failTempRenameOf?: string;
}

const layerFaultyFileSystem = (faults: EditFaults) =>
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

/** The real edit, history, checkpoint and project services over git, in a temp home. */
export const layerEditTest = (baseDir: string, faults: EditFaults = { failTempRename: false }) =>
  Layer.mergeAll(
    EditDocumentService.layer.pipe(
      Layer.provide(EditProjectLayout.layer),
      Layer.provide(layerFaultyFileSystem(faults)),
      Layer.provideMerge(EditHistoryService.layer),
    ),
    ManagedProjectFolders.layer,
    EditProjectLayout.layer,
    ProjectFaviconResolver.layer.pipe(Layer.provide(T3ProjectFileLoader.layer)),
  ).pipe(
    Layer.provideMerge(CheckpointStore.layer),
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
    Layer.provideMerge(NodeServices.layer),
  );

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
