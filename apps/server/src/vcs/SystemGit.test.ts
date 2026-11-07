// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Checks the project folder with plain fs calls.
/**
 * S7V-052: the no-spawn git probe, and the whole editing flow on a Mac whose only git is Apple's
 * stub. The stub opens the "install developer tools" dialog, so the flow must start no process.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EditOp, ProjectId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandResolutionCache,
  SpawnExecutableResolution,
  XcodeGitLocation,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { layerEditTest, type SpawnCounter } from "../edit/editHarness.testkit.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { autoPullProjects } from "../serverRuntimeStartup.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as SystemGit from "./SystemGit.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

/** macOS whose PATH gives `gitOnPath` and whose developer folders hold `disk`. */
const onMac = (input: { gitOnPath: string | undefined; readonly disk: Set<string> }) =>
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const realResolver = yield* SpawnExecutableResolution;
    return yield* effect.pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(SpawnExecutableResolution, (command, platform, env) =>
        command === "git"
          ? input.gitOnPath
          : command.endsWith("/git")
            ? input.disk.has(command)
              ? command
              : undefined
            : realResolver(command, platform, env),
      ),
      Effect.provideService(XcodeGitLocation, () =>
        input.disk.has(XCODE_GIT) ? XCODE_GIT : undefined,
      ),
      Effect.provideService(CommandResolutionCache, new Map()),
    );
  });

describe("SystemGit", () => {
  it.effect("turns git features on after the tools are installed", () => {
    const mac = { gitOnPath: "/usr/bin/git", disk: new Set<string>() };
    return onMac(mac)(
      Effect.gen(function* () {
        const systemGit = yield* SystemGit.make;
        assert.deepEqual(yield* systemGit.status, { available: false, path: null });
        const changes = yield* systemGit.subscribeChanges;
        const firstChange = yield* Stream.runHead(changes).pipe(Effect.forkScoped);

        // Installed while the app runs: the background re-check finds it within one interval.
        mac.disk.add(XCODE_GIT);
        yield* TestClock.adjust(SystemGit.MISSING_GIT_RECHECK_INTERVAL);
        const changed = yield* Fiber.join(firstChange);
        assert.deepEqual(changed._tag === "Some" ? changed.value : null, {
          available: true,
          path: XCODE_GIT,
        });
        assert.deepEqual(yield* systemGit.status, { available: true, path: XCODE_GIT });

        // Opening a project looks again at once.
        mac.disk.delete(XCODE_GIT);
        assert.isFalse((yield* systemGit.refresh).available);
        mac.gitOnPath = "/opt/homebrew/bin/git";
        assert.deepEqual(yield* systemGit.refresh, {
          available: true,
          path: "/opt/homebrew/bin/git",
        });
      }).pipe(Effect.scoped),
    );
  });

  it.effect("skips automatic pulls without git and never asks the driver", () =>
    autoPullProjects(
      [{ id: ProjectId.make("project-1"), workspaceRoot: "/projects/one", autoPull: true }],
      { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          SystemGit.layerFixed({ available: false, path: null }),
        ),
      ),
    ),
  );
});

const setup: ReadonlyArray<EditOp> = [
  {
    _tag: "putMedia",
    media: {
      id: "cam",
      kind: "video",
      path: "assets/cam.mp4",
      fingerprint: { sha256: "ab".repeat(32), size: 4096 },
      probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
    },
  },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];
const keep = (duration: number): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "cam",
  ranges: [{ in: 0, duration }],
});

const layerBackgroundPolicy = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

/**
 * Create, read, apply, undo, redo, a file search and a turn end (the run-finalization refresh and
 * the turn checkpoint's repository check), counting every process started.
 */
const editingFlow = (gitOnPath: string | undefined) => {
  const spawns: SpawnCounter = { count: 0 };
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-no-git-" });
    const layer = Layer.mergeAll(
      WorkspaceEntries.layer,
      VcsStatusBroadcaster.layer.pipe(Layer.provide(layerBackgroundPolicy)),
      CheckpointStore.layer,
    ).pipe(Layer.provideMerge(layerEditTest(baseDir, undefined, { spawns })));
    yield* onMac({ gitOnPath, disk: new Set() })(
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const edits = yield* EditDocumentService.EditDocumentService;
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const checkpoints = yield* CheckpointStore.CheckpointStore;

        const {
          projectId,
          workspaceRoot: root,
          commitError,
        } = yield* folders.createNamedProject({
          name: "Fresh Mac",
        });
        assert.isUndefined(commitError);
        assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".git")));

        const opened = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, [...setup, keep(300)], {
          origin: "agent",
          baseRevision: opened.revision,
        });
        const second = yield* edits.apply(projectId, [keep(90)], {
          origin: "agent",
          baseRevision: first.revision,
        });
        const cut = NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");
        assert.isTrue((yield* edits.undo(projectId)).canRedo);
        yield* edits.redo(projectId);
        assert.strictEqual(NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8"), cut);
        assert.isTrue(second.canUndo);

        const found = yield* entries.search({ cwd: root, query: "edit", limit: 20 });
        assert.isTrue(found.entries.some((entry) => entry.path === "edit.json"));
        yield* entries.list({ cwd: root });
        yield* entries.listIgnoredFiles({ cwd: root });

        // What a turn end runs: the finalization refresh and the checkpoint's repository check.
        yield* entries.refresh(root);
        assert.isFalse((yield* vcsStatus.refreshLocalStatus(root)).isRepo);
        assert.isFalse(yield* checkpoints.isGitRepository(root));
        const status = yield* Stream.runHead(vcsStatus.streamStatus({ cwd: root }));
        assert.isTrue(status._tag === "Some" && status.value._tag === "snapshot");
      }).pipe(Effect.provide(layer)),
    );
    assert.strictEqual(spawns.count, 0, "no process started, so Apple's stub never ran");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
};

describe("a Mac without the developer tools", () => {
  it.effect("never spawns the Apple stub across the editing flow", () =>
    editingFlow("/usr/bin/git"),
  );

  it.effect("works with PATH empty", () => editingFlow(undefined));
});
