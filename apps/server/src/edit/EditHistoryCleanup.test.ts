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

const durationOf = (snapshot: EditSnapshot) =>
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

/** Every object the log names (and the edit last written), as object file names. */
const namedObjects = (root: string) => {
  const log = logOf(root);
  return [
    ...new Set([
      ...log.entries.flatMap((entry) => [entry.files["edit.json"], entry.files["project.json"]]),
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
  const log = (dismissedAt?: EditHistoryService.HistoryUsage) => ({
    ...EditSnapshotStore.EMPTY_HISTORY_LOG,
    ...(dismissedAt === undefined ? {} : { cleanup: { dismissedAt } }),
  });
  const ask = EditHistoryService.CLEANUP_ASK_VERSIONS;
  const bytes = EditHistoryService.CLEANUP_ASK_BYTES;

  it("asks past 50 versions or 200 MB, not at them", () => {
    assert.strictEqual(ask, 50);
    assert.strictEqual(bytes, 200 * 1024 * 1024);
    assert.isFalse(EditHistoryService.cleanupDue({ versions: ask, bytes }, log()));
    assert.isTrue(EditHistoryService.cleanupDue({ versions: ask + 1, bytes: 0 }, log()));
    assert.isTrue(EditHistoryService.cleanupDue({ versions: 2, bytes: bytes + 1 }, log()));
  });

  it("after not now, waits for 50 more versions or double the size", () => {
    const again = EditHistoryService.CLEANUP_ASK_AGAIN_VERSIONS;
    const dismissed = log({ versions: 60, bytes: 300 * 1024 * 1024 });
    assert.isFalse(
      EditHistoryService.cleanupDue({ versions: 60, bytes: 300 * 1024 * 1024 }, dismissed),
    );
    assert.isFalse(
      EditHistoryService.cleanupDue(
        { versions: 60 + again - 1, bytes: 599 * 1024 * 1024 },
        dismissed,
      ),
    );
    assert.isTrue(
      EditHistoryService.cleanupDue({ versions: 60 + again, bytes: 300 * 1024 * 1024 }, dismissed),
    );
    assert.isTrue(
      EditHistoryService.cleanupDue({ versions: 61, bytes: 600 * 1024 * 1024 }, dismissed),
    );
  });
});

describe("keepForCleanup", () => {
  const entry = (seq: number, exported?: boolean): EditSnapshotStore.HistoryEntry => ({
    seq,
    revision: seq,
    files: { "edit.json": "a".repeat(64), "project.json": "b".repeat(64) },
    at: 0,
    ...(exported === undefined ? {} : { exported }),
  });

  it("keeps the last 20, the current step and exported ones", () => {
    assert.strictEqual(EditHistoryService.CLEANUP_KEEP_RECENT, 20);
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry(index + 1, index === 3 || index === 10 ? true : undefined),
    );
    const kept = EditHistoryService.keepForCleanup({
      ...EditSnapshotStore.EMPTY_HISTORY_LOG,
      entries,
      cursor: 30,
    });
    assert.deepEqual(
      [...kept].toSorted((a, b) => a - b),
      [3, 10, 30, ...Array.from({ length: 20 }, (_, index) => 40 + index)],
    );
    // One rule per reason, so S7V-069 adds tagged versions as one more.
    assert.strictEqual(EditHistoryService.CLEANUP_KEEP_RULES.length, 3);
  });
});

describe("history cleanup", () => {
  it.effect("reports history usage", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* makeChanges(project, 5);
        const usage = yield* project.history.usage(project.root);
        assert.strictEqual(usage.versions, logOf(project.root).entries.length);
        assert.strictEqual(usage.versions, 6);
        assert.strictEqual(usage.bytes, objectBytes(project.root));
      }),
    ),
  );

  it.effect("asks once past the threshold and not again after not now", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, projectId } = project;
        // The starting edit plus 50 changes: 51 versions, one past the limit.
        const at50 = yield* makeChanges(project, 49);
        assert.strictEqual(logOf(project.root).entries.length, 50);
        assert.isUndefined(at50.cleanup);
        const at51 = yield* makeChanges(project, 1, 49);
        assert.deepEqual(at51.cleanup, {
          versions: 51,
          bytes: objectBytes(project.root),
        });

        const dismissed = yield* edits.dismissCleanup(projectId);
        assert.isUndefined(dismissed.cleanup);
        assert.deepEqual(logOf(project.root).cleanup, {
          dismissedAt: { versions: 51, bytes: objectBytes(project.root) },
        });
        const later = yield* makeChanges(project, 49, 50);
        assert.isUndefined(later.cleanup);
        // "Not now" stays in the log through every change.
        assert.strictEqual(logOf(project.root).cleanup?.dismissedAt.versions, 51);
        const again = yield* makeChanges(project, 1, 99);
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
            ),
          ),
        );
        const status = yield* fresh.status(project.root);
        assert.isUndefined(status.cleanup);
        assert.strictEqual((yield* fresh.usage(project.root)).versions, 56);
      }),
    ),
  );

  it.effect("keep-recent keeps the last 20, the current and exported ones", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const { edits, history, projectId, root } = project;
        yield* makeChanges(project, 59);
        const before = logOf(root);
        assert.strictEqual(before.entries.length, 60);
        // Two old versions were exported. Entry 0 is the starting edit; entry n keeps 10 + n - 1.
        const exported = [before.entries[3]!, before.entries[10]!];
        for (const entry of exported) yield* history.markExported(root, entry.seq);
        const bytesBefore = objectBytes(root);
        const current = readEdit(root);

        const result = yield* edits.cleanHistory(projectId, "keep-recent");
        const after = logOf(root);
        assert.strictEqual(after.entries.length, 22);
        assert.strictEqual(result.removedVersions, 38);
        assert.deepEqual(
          after.entries.slice(0, 2).map((entry) => entry.seq),
          exported.map((entry) => entry.seq),
        );
        assert.deepEqual(
          after.entries.slice(2).map((entry) => entry.seq),
          before.entries.slice(-20).map((entry) => entry.seq),
        );
        assert.strictEqual(after.cursor, 21);
        assert.deepEqual(historyObjects(root), namedObjects(root));
        assert.strictEqual(result.freedBytes, bytesBefore - objectBytes(root));
        assert.isAbove(result.freedBytes, 0);
        assert.strictEqual(readEdit(root), current);
        const snapshot = yield* edits.read(projectId);
        assert.isUndefined(snapshot.cleanup);
        assert.isTrue(snapshot.canUndo);

        // Undo reaches back to the oldest kept version, then stops; redo still works.
        assert.strictEqual(yield* undoAll(project), 21);
        assert.strictEqual(durationOf(yield* edits.read(projectId)), 10 + 2);
        const redone = yield* edits.redo(projectId);
        assert.strictEqual(durationOf(redone), 10 + 9);
        assert.isTrue(redone.canRedo);
      }),
    ),
  );

  it.effect(
    "dry run removes nothing and reports the space; remove-all keeps only the current edit",
    () =>
      withProject((project) =>
        Effect.gen(function* () {
          const { edits, projectId, root } = project;
          yield* makeChanges(project, 30);
          // One undo, so there is a redo step too.
          yield* edits.undo(projectId);
          const logText = NodeFS.readFileSync(
            NodePath.join(root, ".s7history", "log.json"),
            "utf8",
          );
          const objects = historyObjects(root);
          const bytesBefore = objectBytes(root);
          const current = readEdit(root);

          const preview = yield* edits.cleanHistory(projectId, "remove-all", { dryRun: true });
          assert.strictEqual(preview.removedVersions, 30);
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
          assert.deepEqual(historyObjects(root), namedObjects(root));
          assert.strictEqual(readEdit(root), current);
          const snapshot = yield* edits.read(projectId);
          assert.isFalse(snapshot.canUndo);
          assert.isFalse(snapshot.canRedo);
          const undo = yield* edits.undo(projectId).pipe(Effect.flip);
          assert.strictEqual(undo.reason, "nothing-to-undo");
          // The next change undoes back to the kept edit.
          yield* makeChanges(project, 1, 40);
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

describe("old git leftovers", () => {
  /** An S7V-024 checkpoint ref and its state file, as a project from before S7V-051 has them. */
  const plantLeftovers = (root: string) => {
    const tree = git(root, "write-tree").trim();
    const commit = git(root, "commit-tree", tree, "-m", "old checkpoint").trim();
    git(root, "update-ref", "refs/t3/edit/checkpoints/1", commit);
    // No entries: the import finds nothing to bring in.
    NodeFS.writeFileSync(
      NodePath.join(root, ".s7cache", "edit-history.json"),
      JSON.stringify({ version: 1, nextSeq: 2, highestRevision: 1, cursor: -1, entries: [] }),
    );
  };
  const legacyRefs = (root: string) =>
    git(root, "for-each-ref", "--format=%(refname)", "refs/t3/edit/").trim();

  it.effect("removes old git leftovers only when git works", () => {
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
          plantLeftovers(root);
          yield* makeChanges(project, 10);
          // Keep recent never touches them.
          yield* edits.cleanHistory(projectId, "keep-recent");
          assert.strictEqual(legacyRefs(root), "refs/t3/edit/checkpoints/1");
          yield* edits.cleanHistory(projectId, "remove-all", { dryRun: true });
          assert.strictEqual(legacyRefs(root), "refs/t3/edit/checkpoints/1");

          yield* edits.cleanHistory(projectId, "remove-all");
          assert.strictEqual(legacyRefs(root), "");
          assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".s7cache", "edit-history.json")));
          // T3's own refs and the project's commits stay.
          assert.isAbove(Number(git(root, "rev-list", "--all", "--count").trim()), 0);
        }),
      undefined,
      { legacy },
    );
  });

  it.effect("starts no process without git", () => {
    const spawns: SpawnCounter = { count: 0 };
    const runs = { count: 0 };
    const legacy = Layer.effect(
      LegacyEditHistory.LegacyEditHistory,
      LegacyEditHistory.make({
        available: Effect.succeed(false),
        show: () => Effect.succeedNone,
        run: () =>
          Effect.sync(() => {
            runs.count += 1;
            return { exitCode: 0, stdout: "" };
          }),
      }),
    );
    return withProject(
      (project) =>
        Effect.gen(function* () {
          const { edits, projectId, root } = project;
          plantLeftovers(root);
          yield* makeChanges(project, 10);
          spawns.count = 0;
          yield* edits.cleanHistory(projectId, "remove-all");
          assert.strictEqual(spawns.count, 0);
          assert.strictEqual(runs.count, 0);
          assert.strictEqual(legacyRefs(root), "refs/t3/edit/checkpoints/1");
          assert.isTrue(NodeFS.existsSync(NodePath.join(root, ".s7cache", "edit-history.json")));
          // The old history is not imported after the user removed old versions.
          assert.strictEqual(logOf(root).legacy, "none");
        }),
      undefined,
      { legacy, spawns },
    );
  });
});
