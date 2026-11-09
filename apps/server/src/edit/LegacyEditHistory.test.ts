// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The old git history is built with plain git calls.
/**
 * S7V-051 AC-7: an S7V-024 project (`.s7cache/edit-history.json` and `refs/t3/edit/checkpoints/*`)
 * is imported once. The git access here stands in for S7V-052's no-spawn probe, which wires the
 * same `LegacyEditHistory.make` in the server.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EditOp, GitCommandError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SystemGit from "../vcs/SystemGit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { git, historyLog, layerEditTest, type SpawnCounter } from "./editHarness.testkit.ts";
import * as LegacyEditHistory from "./LegacyEditHistory.ts";

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

const read = (root: string, file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Writes `steps` as S7V-024 left them: one commit per step under refs/t3/edit/checkpoints/. */
const writeOldHistory = (
  root: string,
  steps: ReadonlyArray<{ readonly edit: string; readonly project: string }>,
  cursor: number,
) => {
  const blob = (text: string) =>
    NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: text,
    })
      .toString()
      .trim();
  const entries = steps.map((step, index) => {
    const tree = NodeChildProcess.execFileSync("git", ["mktree"], {
      cwd: root,
      input: `100644 blob ${blob(step.edit)}\tedit.json\n100644 blob ${blob(step.project)}\tproject.json\n`,
    })
      .toString()
      .trim();
    const commit = git(root, "commit-tree", tree, "-m", `edit ${index + 1}`).trim();
    const ref = `refs/t3/edit/checkpoints/${index + 1}`;
    git(root, "update-ref", ref, commit);
    return { seq: index + 1, revision: JSON.parse(step.project).revision, ref };
  });
  NodeFS.rmSync(NodePath.join(root, ".s7history"), { recursive: true, force: true });
  NodeFS.writeFileSync(NodePath.join(root, "edit.json"), steps[cursor]!.edit);
  NodeFS.writeFileSync(NodePath.join(root, "project.json"), steps[cursor]!.project);
  const state = {
    version: 1,
    nextSeq: steps.length + 1,
    highestRevision: Math.max(...entries.map((entry) => entry.revision)),
    cursor,
    entries,
    knownEdit: sha256(steps[cursor]!.edit),
  };
  NodeFS.writeFileSync(
    NodePath.join(root, ".s7cache", "edit-history.json"),
    `${JSON.stringify(state)}\n`,
  );
};

/** Stands in for S7V-052's probe and git; tests flip it between reads. */
interface FakeGit {
  available: boolean;
  showWorks: boolean;
  /** Git cannot run at all (timeout, spawn error, removed): nothing may be decided. */
  runFails?: boolean;
}

/** The server's wiring, optionally with a git driver that cannot run. */
interface ServerGit {
  readonly server: SystemGit.SystemGitStatus;
  readonly driver?: Layer.Layer<GitVcsDriver.GitVcsDriver>;
  /** Bytes of trailing whitespace added to the oldest step's edit.json. */
  readonly padOldestEdit?: number;
}

const withOldProject = <A, E>(
  fake: FakeGit | ServerGit,
  body: (input: {
    readonly root: string;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly projectId: ProjectId;
    readonly steps: ReadonlyArray<{ readonly edit: string; readonly project: string }>;
    readonly shows: { count: number };
    readonly spawns: SpawnCounter;
  }) => Effect.Effect<A, E>,
) => {
  const shows = { count: 0 };
  const spawns: SpawnCounter = { count: 0 };
  const legacy =
    "server" in fake
      ? // The server's wiring: SystemGit decides, the real git driver runs `git show`.
        LegacyEditHistory.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              fake.driver ?? GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
              SystemGit.layerFixed(fake.server),
            ),
          ),
        )
      : Layer.effect(
          LegacyEditHistory.LegacyEditHistory,
          LegacyEditHistory.make({
            available: Effect.sync(() => fake.available),
            show: (cwd, ref, file) =>
              Effect.suspend(() => {
                shows.count += 1;
                if (fake.runFails) {
                  return Effect.fail(new LegacyEditHistory.LegacyGitRunError({ cause: "timeout" }));
                }
                if (!fake.showWorks) return Effect.succeedNone;
                try {
                  return Effect.succeedSome(git(cwd, "show", `${ref}:${file}`));
                } catch {
                  return Effect.succeedNone;
                }
              }),
          }),
        );
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-legacy-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const { projectId, workspaceRoot: root } = yield* folders.createNamedProject({
        name: "Old project",
      });
      // Make four real edit versions with the service, then rewrite them in the old format.
      let snapshot = yield* edits.read(projectId);
      const steps = [{ edit: read(root, "edit.json"), project: read(root, "project.json") }];
      for (const ops of [[...setup, keep(300)], [keep(90)], [keep(30)]]) {
        snapshot = yield* edits.apply(projectId, ops, {
          origin: "agent",
          baseRevision: snapshot.revision,
        });
        steps.push({ edit: read(root, "edit.json"), project: read(root, "project.json") });
      }
      if ("server" in fake && fake.padOldestEdit !== undefined) {
        steps[0] = { ...steps[0]!, edit: steps[0]!.edit + " ".repeat(fake.padOldestEdit) };
      }
      writeOldHistory(root, steps, 2);
      shows.count = 0;
      spawns.count = 0;
      return yield* body({ root, edits, projectId, steps, shows, spawns });
    }).pipe(Effect.provide(layerEditTest(baseDir, undefined, { legacy, spawns })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
};

describe("LegacyEditHistory", () => {
  it.effect("imports an old git history once when git is present", () =>
    withOldProject(
      { available: true, showWorks: true },
      ({ root, edits, projectId, steps, shows }) =>
        Effect.gen(function* () {
          const refs = git(root, "for-each-ref", "refs/t3/edit");
          const oldFile = read(root, ".s7cache/edit-history.json");

          const opened = yield* edits.read(projectId);
          assert.isTrue(opened.canUndo && opened.canRedo);
          assert.strictEqual(opened.revision, JSON.parse(steps[2]!.project).revision);
          assert.strictEqual(shows.count, 8);
          const log = historyLog(root)!;
          assert.strictEqual(log.entries.length, 4);
          assert.strictEqual(log.cursor, 2);
          assert.strictEqual(log.legacy, "imported");

          yield* edits.undo(projectId);
          assert.strictEqual(read(root, "edit.json"), steps[1]!.edit);
          yield* edits.redo(projectId);
          yield* edits.redo(projectId);
          assert.strictEqual(read(root, "edit.json"), steps[3]!.edit);
          assert.strictEqual(shows.count, 8, "imported once");

          assert.strictEqual(git(root, "for-each-ref", "refs/t3/edit"), refs);
          assert.strictEqual(read(root, ".s7cache/edit-history.json"), oldFile);
        }),
    ),
  );

  it.effect("starts fresh when old history exists but no working git", () =>
    withOldProject(
      { available: false, showWorks: true },
      ({ root, edits, projectId, shows, spawns }) =>
        Effect.gen(function* () {
          const oldFile = read(root, ".s7cache/edit-history.json");
          const opened = yield* edits.read(projectId);
          assert.isFalse(opened.canUndo);
          const changed = yield* edits.apply(projectId, [keep(60)], {
            origin: "agent",
            baseRevision: opened.revision,
          });
          assert.isTrue(changed.canUndo);
          assert.strictEqual(historyLog(root)!.entries.length, 2);
          // Not looked at yet, so a later build with a working git still imports it.
          assert.strictEqual(historyLog(root)!.legacy, "unchecked");
          assert.strictEqual(shows.count, 0);
          assert.strictEqual(spawns.count, 0);
          assert.strictEqual(read(root, ".s7cache/edit-history.json"), oldFile);
        }),
    ),
  );

  it.effect("imports an old history in front of changes made before git was found", () => {
    const fake: FakeGit = { available: false, showWorks: true };
    return withOldProject(fake, ({ root, edits, projectId, steps, shows }) =>
      Effect.gen(function* () {
        const opened = yield* edits.read(projectId);
        const changed = yield* edits.apply(projectId, [keep(60)], {
          origin: "agent",
          baseRevision: opened.revision,
        });
        const afterChange = read(root, "edit.json");
        assert.strictEqual(historyLog(root)!.legacy, "unchecked");
        assert.strictEqual(shows.count, 0);

        // A later build finds git (S7V-052): the old steps go in front of the new ones.
        fake.available = true;
        const reopened = yield* edits.read(projectId);
        assert.strictEqual(reopened.revision, changed.revision);
        const log = historyLog(root)!;
        assert.strictEqual(log.legacy, "imported");
        // Old steps 1-2 (the old redo step is dropped; old step 3 equals the new baseline), then
        // the new baseline and the change.
        assert.strictEqual(log.entries.length, 4);
        assert.strictEqual(log.cursor, 3);
        assert.deepEqual(
          log.entries.map((entry) => entry.seq),
          [1, 2, 5, 6],
        );
        assert.strictEqual(read(root, "edit.json"), afterChange);
        yield* edits.undo(projectId);
        assert.strictEqual(read(root, "edit.json"), steps[2]!.edit);
        yield* edits.undo(projectId);
        assert.strictEqual(read(root, "edit.json"), steps[1]!.edit);
        const showsAfterImport = shows.count;
        yield* edits.redo(projectId);
        yield* edits.read(projectId);
        assert.strictEqual(shows.count, showsAfterImport, "imported once");
      }),
    );
  });

  it.effect("records a failed import once instead of retrying it on every read", () =>
    withOldProject({ available: true, showWorks: false }, ({ root, edits, projectId, shows }) =>
      Effect.gen(function* () {
        const opened = yield* edits.read(projectId);
        assert.isFalse(opened.canUndo);
        // One edit.json read per old step, all failing; project.json is never asked for.
        assert.strictEqual(shows.count, 4);
        assert.strictEqual(historyLog(root)!.legacy, "none");
        yield* edits.read(projectId);
        const changed = yield* edits.apply(projectId, [keep(60)], {
          origin: "agent",
          baseRevision: opened.revision,
        });
        yield* edits.undo(projectId);
        yield* edits.redo(projectId);
        assert.isTrue(changed.canUndo);
        assert.strictEqual(shows.count, 4);
        assert.strictEqual(historyLog(root)!.legacy, "none");
      }),
    ),
  );

  // S7V-052 wires the import into the server: SystemGit's probe and a real `git show`.
  describe("as the server wires it", () => {
    it.effect("imports once with a real git found by SystemGit", () =>
      withOldProject(
        { server: { available: true, path: "git" } },
        ({ root, edits, projectId, steps }) =>
          Effect.gen(function* () {
            const refs = git(root, "for-each-ref", "refs/t3/edit");
            const opened = yield* edits.read(projectId);
            assert.isTrue(opened.canUndo && opened.canRedo);
            assert.strictEqual(historyLog(root)!.legacy, "imported");
            assert.strictEqual(historyLog(root)!.entries.length, 4);
            yield* edits.undo(projectId);
            assert.strictEqual(read(root, "edit.json"), steps[1]!.edit);
            assert.strictEqual(git(root, "for-each-ref", "refs/t3/edit"), refs);
          }),
      ),
    );

    it.effect("starts fresh and spawns nothing when SystemGit finds no git", () =>
      withOldProject(
        { server: { available: false, path: null } },
        ({ root, edits, projectId, spawns }) =>
          Effect.gen(function* () {
            const opened = yield* edits.read(projectId);
            assert.isFalse(opened.canUndo);
            yield* edits.apply(projectId, [keep(60)], {
              origin: "agent",
              baseRevision: opened.revision,
            });
            assert.strictEqual(historyLog(root)!.legacy, "unchecked");
            assert.strictEqual(spawns.count, 0);
          }),
      ),
    );

    it.effect("imports an edit.json bigger than git's default 1 MB output limit", () =>
      withOldProject(
        { server: { available: true, path: "git" }, padOldestEdit: 3 * 1024 * 1024 },
        ({ root, edits, projectId }) =>
          Effect.gen(function* () {
            yield* edits.read(projectId);
            const log = historyLog(root)!;
            assert.strictEqual(log.legacy, "imported");
            assert.strictEqual(log.entries.length, 4);
          }),
      ),
    );

    it.effect("leaves the history unchecked when git cannot run, so it is tried again", () =>
      withOldProject(
        {
          server: { available: true, path: "git" },
          driver: Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Git is not installed on this Mac.",
                }),
              ),
          }),
        },
        ({ root, edits, projectId }) =>
          Effect.gen(function* () {
            const opened = yield* edits.read(projectId);
            assert.isFalse(opened.canUndo);
            assert.strictEqual(historyLog(root)?.legacy ?? "unchecked", "unchecked");
          }),
      ),
    );
  });

  it.effect("tries again after git could not run, then imports", () => {
    const fake: FakeGit = { available: true, showWorks: true, runFails: true };
    return withOldProject(fake, ({ root, edits, projectId, shows }) =>
      Effect.gen(function* () {
        const opened = yield* edits.read(projectId);
        const changed = yield* edits.apply(projectId, [keep(60)], {
          origin: "agent",
          baseRevision: opened.revision,
        });
        assert.strictEqual(historyLog(root)!.legacy, "unchecked");
        // Every read looked again, and none of them wrote "none".
        assert.isAbove(shows.count, 1);

        fake.runFails = false;
        yield* edits.read(projectId);
        assert.strictEqual(historyLog(root)!.legacy, "imported");
        assert.strictEqual((yield* edits.read(projectId)).revision, changed.revision);
      }),
    );
  });
});
