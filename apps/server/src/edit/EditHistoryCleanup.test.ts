// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder and git directly.
/**
 * S7V-050: the cleanup question and the two cleanups ("Keep recent", "Remove all old versions")
 * on the real edit and history services in a temp project.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EditOp, type EditSnapshot, type ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SystemGit from "../vcs/SystemGit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import * as EditHistoryService from "./EditHistoryService.ts";
import {
  type EditFaults,
  type EditTestOptions,
  git,
  historyLog,
  historyObjects,
  layerEditTest,
  type SpawnCounter,
} from "./editHarness.testkit.ts";
import * as EditSnapshotStore from "./EditSnapshotStore.ts";
import * as LegacyEditHistory from "./LegacyEditHistory.ts";

const media = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: 9000, hasVideo: true, hasAudio: true },
} as const;

const setup: ReadonlyArray<EditOp> = [
  { _tag: "putMedia", media },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];
const keep = (duration: number): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "cam",
  ranges: [{ in: 0, duration }],
});

interface Project {
  readonly projectId: ProjectId;
  readonly root: string;
  readonly edits: EditDocumentService.EditDocumentService["Service"];
  readonly history: EditHistoryService.EditHistoryService["Service"];
  readonly store: EditSnapshotStore.EditSnapshotStore["Service"];
}

const withProject = <A, E>(
  body: (project: Project & { readonly baseDir: string }) => Effect.Effect<A, E>,
  faults?: EditFaults,
  options?: EditTestOptions,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-cleanup-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const created = yield* folders.createNamedProject({ name: "Cleanup test" });
      return yield* body({
        baseDir,
        projectId: created.projectId,
        root: created.workspaceRoot,
        edits: yield* EditDocumentService.EditDocumentService,
        history: yield* EditHistoryService.EditHistoryService,
        store: yield* EditSnapshotStore.EditSnapshotStore,
      });
    }).pipe(Effect.provide(layerEditTest(baseDir, faults, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** `count` committed changes after the starting edit; the first also adds the clip and track. */
const makeChanges = Effect.fnUntraced(function* (
  { edits, projectId }: Project,
  count: number,
  from = 0,
) {
  let snapshot = yield* edits.read(projectId);
  for (let index = from; index < from + count; index++) {
    const ops = index === 0 ? [...setup, keep(10)] : [keep(10 + index)];
    snapshot = yield* edits.apply(projectId, ops, {
      origin: "agent",
      baseRevision: snapshot.revision,
    });
  }
  return snapshot;
});

const durationOf = (snapshot: Pick<EditSnapshot, "document">) =>
  snapshot.document.tracks[0]?.items.reduce((sum, item) => sum + item.duration, 0) ?? 0;

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

const logOf = (root: string) => {
  const log = historyLog(root);
  assert.isNotNull(log);
  return log!;
};

const objectBytes = (root: string) =>
  historyObjects(root).reduce(
    (sum, name) => sum + NodeFS.statSync(NodePath.join(root, ".s7history", "objects", name)).size,
    0,
  );

/** Every object the log's steps and versions name (and the edit last written), as file names. */
const namedObjects = (root: string) => {
  const log = logOf(root);
  return [
    ...new Set([
      ...[...log.entries, ...(log.versions ?? [])].flatMap(({ files }) => [
        files["edit.json"],
        files["project.json"],
      ]),
      ...(log.knownEdit === undefined ? [] : [log.knownEdit]),
    ]),
  ]
    .map((id) => `${id}.json.gz`)
    .toSorted();
};

/** Bytes and modification time of every file outside `.s7history/` (AC-4). */
const projectFiles = (root: string) =>
  Object.fromEntries(
    NodeFS.readdirSync(root, { recursive: true })
      .map(String)
      .filter((name) => !name.startsWith(".s7history") && !name.startsWith(".git/"))
      .filter((name) => NodeFS.statSync(NodePath.join(root, name)).isFile())
      .toSorted()
      .map((name) => {
        const file = NodePath.join(root, name);
        return [
          name,
          { bytes: NodeFS.readFileSync(file, "base64"), mtime: NodeFS.statSync(file).mtimeMs },
        ];
      }),
  );

/** Undoes until there is nothing left; how many steps it took. */
const undoAll = Effect.fnUntraced(function* ({ edits, projectId }: Project) {
  let steps = 0;
  for (;;) {
    const result = yield* edits.undo(projectId).pipe(Effect.result);
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure.reason, "nothing-to-undo");
      return steps;
    }
    steps += 1;
  }
});

describe("cleanupDue", () => {
  const log = (
    nextVersion: number,
    dismissedAt?: { nextVersion: number; bytes: number },
  ): EditSnapshotStore.HistoryLog => ({
    ...EditSnapshotStore.EMPTY_HISTORY_LOG,
    nextVersion,
    ...(dismissedAt === undefined ? {} : { cleanup: { dismissedAt } }),
  });
  const ask = EditHistoryService.CLEANUP_ASK_VERSIONS;
  const bytes = EditHistoryService.CLEANUP_ASK_BYTES;
  const MB = 1024 * 1024;

  it("asks past 50 versions or 200 MB, not at them", () => {
    assert.strictEqual(ask, 50);
    assert.strictEqual(bytes, 200 * MB);
    assert.isFalse(EditHistoryService.cleanupDue({ versions: ask, bytes }, log(51)));
    assert.isTrue(EditHistoryService.cleanupDue({ versions: ask + 1, bytes: 0 }, log(52)));
    assert.isTrue(EditHistoryService.cleanupDue({ versions: 2, bytes: bytes + 1 }, log(3)));
  });

  it("after not now, waits for 50 more versions saved or double the size", () => {
    assert.strictEqual(EditHistoryService.CLEANUP_ASK_AGAIN_VERSIONS, 50);
    const dismissedAt = { nextVersion: 61, bytes: 300 * MB };
    const usage = { versions: 60, bytes: 300 * MB };
    assert.isFalse(EditHistoryService.cleanupDue(usage, log(61, dismissedAt)));
    assert.isFalse(
      EditHistoryService.cleanupDue({ versions: 109, bytes: 599 * MB }, log(110, dismissedAt)),
    );
    assert.isTrue(
      EditHistoryService.cleanupDue({ versions: 110, bytes: 300 * MB }, log(111, dismissedAt)),
    );
    assert.isTrue(
      EditHistoryService.cleanupDue({ versions: 61, bytes: 600 * MB }, log(62, dismissedAt)),
    );
  });

  it("counts versions saved since not now, so deleted versions or the step cap never hide growth", () => {
    // Said "Not now" at 180 versions; versions were deleted since, so only 100 are listed.
    const dismissedAt = { nextVersion: 181, bytes: 300 * MB };
    assert.isTrue(
      EditHistoryService.cleanupDue({ versions: 100, bytes: 300 * MB }, log(231, dismissedAt)),
    );
    assert.isFalse(
      EditHistoryService.cleanupDue({ versions: 100, bytes: 300 * MB }, log(230, dismissedAt)),
    );
  });
});

describe("keepForCleanup", () => {
  const version = (n: number, extra: Partial<EditSnapshotStore.EditVersionRecord> = {}) =>
    ({
      n,
      files: { "edit.json": "a".repeat(64), "project.json": "b".repeat(64) },
      revision: n,
      at: 0,
      author: "you",
      changes: ["Changed the edit"],
      ...extra,
    }) satisfies EditSnapshotStore.EditVersionRecord;
  const versions = Array.from({ length: 60 }, (_, index) =>
    version(index + 1, index === 3 ? { tag: "first cut" } : index === 10 ? { exported: true } : {}),
  );
  const numbers = (kept: ReadonlyArray<EditSnapshotStore.EditVersionRecord>) =>
    kept.map((entry) => entry.n);

  it("keep-recent keeps the last 20, the current, tagged and exported versions", () => {
    assert.strictEqual(EditHistoryService.CLEANUP_KEEP_RECENT, 20);
    assert.deepEqual(numbers(EditHistoryService.keepForCleanup(versions, "keep-recent")), [
      4,
      11,
      ...Array.from({ length: 20 }, (_, index) => 41 + index),
    ]);
  });

  it("remove-all keeps the current, tagged and exported versions", () => {
    assert.deepEqual(
      numbers(EditHistoryService.keepForCleanup(versions, "remove-all")),
      [4, 11, 60],
    );
    assert.deepEqual(numbers(EditHistoryService.keepForCleanup([], "remove-all")), []);
  });
});

describe("history cleanup", () => {
  it.effect("reports history usage in versions, not undo steps", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* makeChanges(project, 5);
        const usage = yield* project.history.usage(project.root);
        // Five changes: five versions; the starting edit is an undo step but no version.
        assert.strictEqual(usage.versions, 5);
        assert.strictEqual(logOf(project.root).entries.length, 6);
        assert.strictEqual(usage.bytes, objectBytes(project.root));
      }),
    ),
  );

  it.effect("asks once past the threshold and not again after not now", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, projectId } = project;
        const at50 = yield* makeChanges(project, 50);
        assert.strictEqual(logOf(project.root).versions?.length, 50);
        assert.isUndefined(at50.cleanup);
        const at51 = yield* makeChanges(project, 1, 50);
        assert.deepEqual(at51.cleanup, { versions: 51, bytes: objectBytes(project.root) });

        const dismissed = yield* edits.dismissCleanup(projectId);
        assert.isUndefined(dismissed.cleanup);
        assert.deepEqual(logOf(project.root).cleanup, {
          dismissedAt: { nextVersion: 52, bytes: objectBytes(project.root) },
        });
        const later = yield* makeChanges(project, 49, 51);
        assert.isUndefined(later.cleanup);
        // "Not now" stays in the log through every change.
        assert.strictEqual(logOf(project.root).cleanup?.dismissedAt.nextVersion, 52);
        const again = yield* makeChanges(project, 1, 100);
        assert.strictEqual(again.cleanup?.versions, 101);
        assert.isDefined((yield* edits.read(projectId)).cleanup);
      }),
    ),
  );

  it.effect("not now survives a restart", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* makeChanges(project, 55);
        assert.isDefined((yield* project.edits.read(project.projectId)).cleanup);
        yield* project.edits.dismissCleanup(project.projectId);
        // A new history service reads the same log, as after a restart.
        const fresh = yield* EditHistoryService.EditHistoryService.pipe(
          Effect.provide(
            EditHistoryService.layer.pipe(
              Layer.provide(LegacyEditHistory.layerNone),
              Layer.provide(EditSnapshotStore.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        const status = yield* fresh.status(project.root);
        assert.isUndefined(status.cleanup);
        assert.strictEqual((yield* fresh.usage(project.root)).versions, 55);
      }),
    ),
  );

  it.effect("keep-recent keeps the last 20 versions, the current, tagged and exported ones", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, history, projectId, root } = project;
        yield* makeChanges(project, 59);
        const before = logOf(root);
        assert.strictEqual(before.entries.length, 60);
        assert.deepEqual(
          before.versions?.map((version) => version.n),
          Array.from({ length: 59 }, (_, index) => index + 1),
        );
        yield* edits.tagVersion(projectId, 2, "first cut");
        yield* history.markExported(root, 4);
        yield* history.markExported(root, 11);
        const bytesBefore = objectBytes(root);
        const current = readEdit(root);

        const result = yield* edits.cleanHistory(projectId, "keep-recent");
        const after = logOf(root);
        assert.deepEqual(
          after.versions?.map((version) => version.n),
          [2, 4, 11, ...Array.from({ length: 20 }, (_, index) => 40 + index)],
        );
        assert.strictEqual(after.versions?.[0]?.tag, "first cut");
        assert.strictEqual(result.removedVersions, 36);
        // Undo keeps the newest 20 steps (the current one among them).
        assert.strictEqual(result.removedSteps, 40);
        assert.deepEqual(
          after.entries.map((entry) => entry.seq),
          before.entries.slice(-20).map((entry) => entry.seq),
        );
        assert.strictEqual(after.cursor, 19);
        // Numbers never restart.
        assert.strictEqual(after.nextVersion, 60);
        // Only the objects kept steps and versions use stay.
        assert.deepEqual(historyObjects(root), namedObjects(root));
        assert.strictEqual(result.freedBytes, bytesBefore - objectBytes(root));
        assert.isAbove(result.freedBytes, 0);
        assert.strictEqual(readEdit(root), current);
        const snapshot = yield* edits.read(projectId);
        assert.isUndefined(snapshot.cleanup);
        assert.isTrue(snapshot.canUndo);
        assert.strictEqual(snapshot.version, 59);
        // A kept old version still opens.
        assert.strictEqual(durationOf(yield* edits.versionDocument(projectId, 4)), 10 + 3);

        // Undo reaches back to the oldest kept step, then stops; redo still works.
        assert.strictEqual(yield* undoAll(project), 19);
        // Entry n keeps 10 + n - 1 frames; the oldest kept step is entry 40.
        assert.strictEqual(durationOf(yield* edits.read(projectId)), 10 + 39);
        const redone = yield* edits.redo(projectId);
        assert.strictEqual(durationOf(redone), 10 + 40);
        assert.isTrue(redone.canRedo);
      }),
    ),
  );

  it.effect(
    "dry run removes nothing and reports the space; remove-all keeps the current, tagged and exported versions",
    () =>
      withProject((project) =>
        Effect.gen(function* () {
          const { edits, history, projectId, root } = project;
          yield* makeChanges(project, 30);
          // One undo, so there is a redo step too; the undo is version 31.
          yield* edits.undo(projectId);
          yield* edits.tagVersion(projectId, 5, "keeper");
          yield* history.markExported(root, 7);
          const logText = NodeFS.readFileSync(
            NodePath.join(root, ".s7history", "log.json"),
            "utf8",
          );
          const objects = historyObjects(root);
          const bytesBefore = objectBytes(root);
          const current = readEdit(root);

          const preview = yield* edits.cleanHistory(projectId, "remove-all", { dryRun: true });
          assert.strictEqual(preview.removedVersions, 28);
          assert.strictEqual(preview.removedSteps, 30);
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(root, ".s7history", "log.json"), "utf8"),
            logText,
          );
          assert.deepEqual(historyObjects(root), objects);

          const result = yield* edits.cleanHistory(projectId, "remove-all");
          assert.deepEqual(result, preview);
          assert.strictEqual(result.freedBytes, bytesBefore - objectBytes(root));
          const log = logOf(root);
          assert.strictEqual(log.entries.length, 1);
          assert.strictEqual(log.cursor, 0);
          assert.deepEqual(
            log.versions?.map((version) => version.n),
            [5, 7, 31],
          );
          assert.strictEqual(log.nextVersion, 32);
          assert.deepEqual(historyObjects(root), namedObjects(root));
          assert.strictEqual(readEdit(root), current);
          const snapshot = yield* edits.read(projectId);
          assert.isFalse(snapshot.canUndo);
          assert.isFalse(snapshot.canRedo);
          const undo = yield* edits.undo(projectId).pipe(Effect.flip);
          assert.strictEqual(undo.reason, "nothing-to-undo");
          // The next change is v32, and undoes back to the kept edit.
          const next = yield* makeChanges(project, 1, 40);
          assert.strictEqual(next.version, 32);
          assert.strictEqual(durationOf(yield* edits.undo(projectId)), durationOf(snapshot));
        }),
      ),
  );

  it.effect("publishes the cleaned snapshot to subscribers", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, projectId } = project;
        yield* makeChanges(project, 55);
        const seen: Array<EditSnapshot> = [];
        const first = yield* Deferred.make<void>();
        const fiber = yield* edits.subscribe(projectId).pipe(
          Stream.take(2),
          Stream.runForEach((snapshot) =>
            Effect.sync(() => seen.push(snapshot)).pipe(
              Effect.andThen(Deferred.succeed(first, undefined)),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        assert.isDefined(seen[0]!.cleanup);
        yield* edits.cleanHistory(projectId, "remove-all");
        yield* Fiber.join(fiber);
        assert.isUndefined(seen[1]!.cleanup);
        assert.isFalse(seen[1]!.canUndo);
      }),
    ),
  );

  it.effect("cleanup never touches edit, project or media files", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, projectId, root } = project;
        yield* makeChanges(project, 30);
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), "not really a video");
        NodeFS.writeFileSync(NodePath.join(root, "exports", "old.mp4"), "an old export");
        NodeFS.mkdirSync(NodePath.join(root, ".s7cache", "transcripts"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, ".s7cache", "transcripts", "cam.json"), "{}");
        NodeFS.mkdirSync(NodePath.join(root, "styles"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "styles", "house.json"), "{}");
        const before = projectFiles(root);
        assert.includeMembers(Object.keys(before), [
          "edit.json",
          "project.json",
          "assets/cam.mp4",
          "exports/old.mp4",
          "styles/house.json",
        ]);
        yield* edits.cleanHistory(projectId, "remove-all", { dryRun: true });
        yield* edits.cleanHistory(projectId, "keep-recent");
        yield* edits.cleanHistory(projectId, "remove-all");
        assert.deepEqual(projectFiles(root), before);
      }),
    ),
  );

  it.effect("cleanup during an apply waits for the project lock", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, projectId, root } = project;
        const snapshot = yield* makeChanges(project, 40);
        const [applied, cleaned] = yield* Effect.all(
          [
            edits.apply(projectId, [keep(500)], {
              origin: "timeline",
              baseRevision: snapshot.revision,
            }),
            edits.cleanHistory(projectId, "keep-recent"),
          ],
          { concurrency: 2 },
        );
        assert.isAbove(applied.revision, snapshot.revision);
        assert.isAbove(cleaned.removedVersions, 0);
        const log = logOf(root);
        assert.isAtMost(log.entries.length, 21);
        assert.strictEqual(log.cursor, log.entries.length - 1);
        assert.deepEqual(historyObjects(root), namedObjects(root));
        assert.strictEqual(durationOf(yield* edits.read(projectId)), 500);
        yield* edits.undo(projectId);
      }),
    ),
  );

  it.effect("crash during cleanup leaves a usable history", () => {
    const faults: EditFaults = { failTempRename: false };
    return withProject(
      (project) =>
        Effect.gen(function* () {
          const { edits, projectId, root } = project;
          yield* makeChanges(project, 30);
          const logText = NodeFS.readFileSync(
            NodePath.join(root, ".s7history", "log.json"),
            "utf8",
          );
          const objects = historyObjects(root);
          faults.failTempRenameOf = "log.json";
          const error = yield* edits.cleanHistory(projectId, "remove-all").pipe(Effect.flip);
          delete faults.failTempRenameOf;
          assert.strictEqual(error.reason, "checkpoint-failed");
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(root, ".s7history", "log.json"), "utf8"),
            logText,
          );
          assert.deepEqual(historyObjects(root), objects);
          assert.strictEqual(yield* undoAll(project), 30);
        }),
      faults,
    );
  });
});

describe("old git leftovers (PO 2026-11-08: only this project's named refs, plain gc)", () => {
  const T3_REF = "refs/t3/orchestration-v2/checkpoints/turn-1";
  const commitIn = (repo: string) => {
    const tree = git(repo, "write-tree").trim();
    return git(repo, "commit-tree", tree, "-m", "old checkpoint").trim();
  };
  /**
   * S7V-024 leftovers as a project from before S7V-051 has them: `.s7cache/edit-history.json`
   * naming `refs/t3/edit/checkpoints/1` and `/2` (only 1 exists), plus a ref the file does not name
   * and one of T3's own turn refs, which must both survive.
   */
  const plantLeftovers = (repo: string, project = repo) => {
    const commit = commitIn(repo);
    for (const ref of ["refs/t3/edit/checkpoints/1", "refs/t3/edit/checkpoints/99", T3_REF]) {
      git(repo, "update-ref", ref, commit);
    }
    NodeFS.mkdirSync(NodePath.join(project, ".s7cache"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, ".s7cache", "edit-history.json"),
      JSON.stringify({
        version: 1,
        nextSeq: 3,
        highestRevision: 2,
        cursor: 1,
        entries: [
          { seq: 1, revision: 1, ref: "refs/t3/edit/checkpoints/1" },
          { seq: 2, revision: 2, ref: "refs/t3/edit/checkpoints/2" },
        ],
      }),
    );
  };
  const refsOf = (repo: string) =>
    git(repo, "for-each-ref", "--format=%(refname)", "refs/t3/").trim().split("\n").toSorted();
  const packs = (repo: string) =>
    NodeFS.readdirSync(NodePath.join(repo, ".git", "objects", "pack")).filter((name) =>
      name.endsWith(".pack"),
    );
  const stateFile = (project: string) => NodePath.join(project, ".s7cache", "edit-history.json");

  /** Git access that runs the real git and records each command's arguments. */
  const recordingGit = (available: boolean) => {
    const runs: Array<ReadonlyArray<string>> = [];
    const access: LegacyEditHistory.LegacyGitAccess = {
      available: Effect.succeed(available),
      show: () => Effect.succeedNone,
      run: (cwd, args, stdin) =>
        Effect.sync(() => {
          runs.push(args);
          const result = NodeChildProcess.spawnSync("git", args, {
            cwd,
            input: stdin,
            encoding: "utf8",
          });
          return { exitCode: result.status ?? 1, stdout: result.stdout };
        }),
    };
    return { runs, access };
  };
  const removeWith = (access: LegacyEditHistory.LegacyGitAccess, cwd: string) =>
    Effect.gen(function* () {
      const legacy = yield* LegacyEditHistory.make(access);
      return yield* legacy.removeLeftovers(cwd);
    }).pipe(Effect.provide(NodeServices.layer));
  const tempRepo = Effect.fnUntraced(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const repo = NodeFS.realpathSync(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-git-" }),
    );
    git(repo, "init", "--quiet");
    NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "x");
    git(repo, "add", "README.md");
    return repo;
  });

  it.effect("remove-all deletes only the named refs and the file, then runs plain gc", () => {
    const legacy = LegacyEditHistory.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
          SystemGit.layerFixed({ available: true, path: "git" }),
        ),
      ),
    );
    return withProject(
      (project) =>
        Effect.gen(function* () {
          const { edits, projectId, root } = project;
          yield* makeChanges(project, 10);
          plantLeftovers(root);
          assert.deepEqual(packs(root), []);
          // Keep recent and a dry run never touch them.
          yield* edits.cleanHistory(projectId, "keep-recent");
          yield* edits.cleanHistory(projectId, "remove-all", { dryRun: true });
          assert.include(refsOf(root), "refs/t3/edit/checkpoints/1");
          assert.isTrue(NodeFS.existsSync(stateFile(root)));

          yield* edits.cleanHistory(projectId, "remove-all");
          // The named ref is gone; the unnamed one and T3's turn ref stay.
          assert.deepEqual(refsOf(root), ["refs/t3/edit/checkpoints/99", T3_REF]);
          assert.isFalse(NodeFS.existsSync(stateFile(root)));
          // gc ran: the loose objects are packed, and every ref still resolves.
          assert.isAbove(packs(root).length, 0);
          git(root, "cat-file", "-e", `${T3_REF}^{commit}`);
        }),
      undefined,
      { legacy },
    );
  });

  it.effect("runs no gc when no named ref exists, and removes the stale file", () =>
    Effect.gen(function* () {
      const repo = yield* tempRepo();
      plantLeftovers(repo);
      git(repo, "update-ref", "-d", "refs/t3/edit/checkpoints/1");
      const { runs, access } = recordingGit(true);
      assert.isTrue(yield* removeWith(access, repo));
      assert.isFalse(runs.some((args) => args[0] === "gc" || args[0] === "update-ref"));
      assert.isFalse(NodeFS.existsSync(stateFile(repo)));
      assert.deepEqual(refsOf(repo), ["refs/t3/edit/checkpoints/99", T3_REF]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts no git at all without the old file", () =>
    Effect.gen(function* () {
      const repo = yield* tempRepo();
      git(repo, "update-ref", "refs/t3/edit/checkpoints/1", commitIn(repo));
      const { runs, access } = recordingGit(true);
      assert.isFalse(yield* removeWith(access, repo));
      assert.deepEqual(runs, []);
      assert.include(refsOf(repo), "refs/t3/edit/checkpoints/1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does nothing for a project folder nested inside another repository", () =>
    Effect.gen(function* () {
      const repo = yield* tempRepo();
      const nested = NodePath.join(repo, "videos", "My project");
      NodeFS.mkdirSync(nested, { recursive: true });
      plantLeftovers(repo, nested);
      const { runs, access } = recordingGit(true);
      assert.isFalse(yield* removeWith(access, nested));
      assert.deepEqual(runs, [["rev-parse", "--show-toplevel"]]);
      assert.include(refsOf(repo), "refs/t3/edit/checkpoints/1");
      assert.isTrue(NodeFS.existsSync(stateFile(nested)));
      assert.deepEqual(packs(repo), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts no process without git", () => {
    const spawns: SpawnCounter = { count: 0 };
    const { runs, access } = recordingGit(false);
    const legacy = Layer.effect(
      LegacyEditHistory.LegacyEditHistory,
      LegacyEditHistory.make(access),
    );
    return withProject(
      (project) =>
        Effect.gen(function* () {
          const { edits, projectId, root } = project;
          yield* makeChanges(project, 10);
          plantLeftovers(root);
          spawns.count = 0;
          yield* edits.cleanHistory(projectId, "remove-all");
          assert.strictEqual(spawns.count, 0);
          assert.deepEqual(runs, []);
          assert.include(refsOf(root), "refs/t3/edit/checkpoints/1");
          assert.isTrue(NodeFS.existsSync(stateFile(root)));
          // The old history is not imported after the user removed old versions.
          assert.strictEqual(logOf(root).legacy, "none");
        }),
      undefined,
      { legacy, spawns },
    );
  });
});
