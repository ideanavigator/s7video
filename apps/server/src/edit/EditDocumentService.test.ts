// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder and git directly.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EditOp, type EditSnapshot, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import * as EditHistoryService from "./EditHistoryService.ts";
import {
  type EditFaults,
  type EditTestOptions,
  git,
  historyLog,
  historyObjects,
  isIgnored,
  layerEditTest,
} from "./editHarness.testkit.ts";
import * as EditSnapshotStore from "./EditSnapshotStore.ts";

const media = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
} as const;

const setup: ReadonlyArray<EditOp> = [
  { _tag: "putMedia", media },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];
const keep = (ranges: ReadonlyArray<readonly [number, number]>): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "cam",
  ranges: ranges.map(([at, duration]) => ({ in: at, duration })),
});

const withProject = <A, E>(
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly store: EditSnapshotStore.EditSnapshotStore["Service"];
    readonly history: EditHistoryService.EditHistoryService["Service"];
  }) => Effect.Effect<A, E>,
  faults?: EditFaults,
  options?: EditTestOptions,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-edit-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const store = yield* EditSnapshotStore.EditSnapshotStore;
      const history = yield* EditHistoryService.EditHistoryService;
      const created = yield* folders.createNamedProject({ name: "Edit test" });
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        edits,
        store,
        history,
      });
    }).pipe(Effect.provide(layerEditTest(baseDir, faults, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

/** Every object the log names (undo steps and versions), as file names under `.s7history/objects/`. */
const namedObjects = (root: string) =>
  [
    ...new Set(
      [...(historyLog(root)?.entries ?? []), ...(historyLog(root)?.versions ?? [])].flatMap(
        (entry) => [
          `${entry.files["edit.json"]}.json.gz`,
          `${entry.files["project.json"]}.json.gz`,
        ],
      ),
    ),
  ].toSorted();

/** Ref names, commit count and index file of the project's git repo. */
const gitState = (root: string) => ({
  refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)").trim(),
  commits: git(root, "rev-list", "--all", "--count").trim(),
  index: NodeFS.statSync(NodePath.join(root, ".git", "index")).mtimeMs,
  indexFiles: NodeFS.readdirSync(NodePath.join(root, ".git")).filter((name) =>
    name.includes("index"),
  ),
});

describe("EditDocumentService", () => {
  it.effect("creates a managed edit project with the whitelist layout", () =>
    withProject(({ root }) =>
      Effect.sync(() => {
        for (const entry of ["edit.json", "project.json", ".gitignore"]) {
          assert.isTrue(NodeFS.statSync(NodePath.join(root, entry)).isFile(), entry);
        }
        for (const folder of ["styles", "assets", ".s7cache", "exports"]) {
          assert.isTrue(NodeFS.statSync(NodePath.join(root, folder)).isDirectory(), folder);
        }
        assert.deepEqual(git(root, "ls-files").trim().split("\n").sort(), [
          ".gitignore",
          "README.md",
          "assets/icon.svg",
          "edit.json",
          "project.json",
        ]);
        // should not touch ~/.t3: the project lives in the test's temp home.
        assert.include(root, "s7v-edit-");
        assert.isFalse(root.startsWith(NodePath.join(NodeOS.homedir(), ".t3")));
      }),
    ),
  );

  it.effect("undoes two of three applies byte for byte and redoes one", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        assert.isFalse(initial.canUndo);
        const first = yield* edits.apply(projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const afterFirst = readEdit(root);
        const second = yield* edits.apply(
          projectId,
          [
            keep([
              [0, 90],
              [120, 180],
            ]),
          ],
          {
            origin: "timeline",
            baseRevision: first.revision,
          },
        );
        const afterSecond = readEdit(root);
        const third = yield* edits.apply(
          projectId,
          [{ _tag: "deleteItem", itemIds: ["v1"], ripple: true }],
          { origin: "transcript", baseRevision: second.revision },
        );
        assert.notStrictEqual(readEdit(root), afterSecond);

        yield* edits.undo(projectId);
        const undone = yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), afterFirst);
        assert.isTrue(undone.revision > third.revision, "revisions only go up");
        assert.isTrue(undone.canUndo && undone.canRedo);

        const redone = yield* edits.redo(projectId);
        assert.strictEqual(readEdit(root), afterSecond);
        assert.deepEqual(redone.document, second.document);
      }),
    ),
  );

  it.effect("records no revision or checkpoint when the ops leave edit.json unchanged", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const before = readEdit(root);
        const log = historyLog(root);
        const objects = historyObjects(root);
        const again = yield* edits.apply(projectId, [keep([[0, 300]])], {
          origin: "agent",
          baseRevision: first.revision,
        });
        assert.strictEqual(again.revision, first.revision);
        assert.strictEqual(readEdit(root), before);
        assert.deepEqual(historyLog(root), log);
        assert.deepEqual(historyObjects(root), objects);

        // One undo still goes back past the first apply.
        yield* edits.undo(projectId);
        assert.isFalse((yield* edits.read(projectId)).canUndo);
      }),
    ),
  );

  it.effect("should return EditConflict on stale base revision and change nothing", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        yield* edits.apply(projectId, setup, { origin: "agent", baseRevision: initial.revision });
        const before = readEdit(root);
        const error = yield* edits
          .apply(projectId, [keep([[0, 30]])], {
            origin: "timeline",
            baseRevision: initial.revision,
          })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "EditConflict");
        assert.strictEqual(readEdit(root), before);
      }),
    ),
  );

  it.effect("rejects an op batch that would make the edit invalid, naming the item", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const before = readEdit(root);
        const error = yield* edits
          .apply(
            projectId,
            [
              ...setup,
              keep([[0, 300]]),
              {
                _tag: "insertItem",
                trackId: "V1",
                item: { id: "late", media: "cam", start: 100, duration: 50, in: 0 },
              },
            ],
            { origin: "agent", baseRevision: initial.revision },
          )
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "EditValidationError");
        if (error._tag === "EditValidationError") {
          assert.strictEqual(error.reason, "overlap");
          assert.strictEqual(error.itemId, "late");
          assert.include(error.message, '"late"');
        }
        assert.strictEqual(readEdit(root), before);
      }),
    ),
  );

  it.effect("should keep untracked notes on restore", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        yield* edits.apply(projectId, [keep([[0, 30]])], {
          origin: "agent",
          baseRevision: first.revision,
        });
        const notes = ["assets/notes.txt", "exports/notes.txt", "notes.md"];
        for (const note of notes) NodeFS.writeFileSync(NodePath.join(root, note), "mine\n");
        yield* edits.undo(projectId);
        for (const note of notes) {
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(root, note), "utf8"),
            "mine\n",
            note,
          );
        }
      }),
    ),
  );

  it.effect("undo and redo change only edit.json and project.json", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const afterFirst = readEdit(root);
        yield* edits.apply(projectId, [keep([[0, 30]])], {
          origin: "agent",
          baseRevision: first.revision,
        });
        // Files the history also saves, created or changed after the last checkpoint.
        NodeFS.mkdirSync(NodePath.join(root, "styles", "fonts"), { recursive: true });
        const kept: Record<string, string> = {
          "styles/brand.json": '{"colour":"teal"}\n',
          "styles/fonts/mine.otf": "font bytes",
          "README.md": "# My own notes\n",
        };
        for (const [file, text] of Object.entries(kept)) {
          NodeFS.writeFileSync(NodePath.join(root, file), text);
        }
        yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), afterFirst);
        yield* edits.redo(projectId);
        yield* edits.undo(projectId);
        for (const [file, text] of Object.entries(kept)) {
          assert.strictEqual(NodeFS.readFileSync(NodePath.join(root, file), "utf8"), text, file);
        }
      }),
    ),
  );

  it.effect("records an edit.json changed outside the service and tells subscribers", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const applied = yield* edits.apply(projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const afterApply = readEdit(root);
        const seen: EditSnapshot[] = [];
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* edits.subscribe(projectId).pipe(
          Stream.take(2),
          Stream.runForEach((snapshot) =>
            Effect.sync(() => seen.push(snapshot)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        // As a T3 turn revert or an agent writing the file directly would.
        const outside = { ...applied.document, metadata: { note: "written outside" } };
        NodeFS.writeFileSync(NodePath.join(root, "edit.json"), JSON.stringify(outside));
        const stale = yield* edits
          .apply(projectId, [keep([[0, 10]])], {
            origin: "timeline",
            baseRevision: applied.revision,
          })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "EditConflict");
        yield* Fiber.join(fiber);
        assert.deepEqual(seen[1]!.document.metadata, { note: "written outside" });
        assert.isAbove(seen[1]!.revision, applied.revision);
        yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), afterApply);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("should block capture when media is outside ignored folders", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        // A clip at the root is ignored by the whitelist, so it never blocks or enters git.
        NodeFS.writeFileSync(NodePath.join(root, "stray-clip.mp4"), Buffer.alloc(20 * 1024 * 1024));
        assert.isTrue(isIgnored(root, "stray-clip.mp4"));
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        // styles/ is tracked: a clip there, or any file over 10 MiB, blocks the next change.
        NodeFS.writeFileSync(NodePath.join(root, "styles", "intro.mov"), "not really a movie");
        const before = readEdit(root);
        const blocked = yield* edits
          .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: first.revision })
          .pipe(Effect.flip);
        assert.strictEqual(blocked._tag, "EditUnavailableError");
        if (blocked._tag === "EditUnavailableError") {
          assert.strictEqual(blocked.reason, "media-in-tracked-folder");
          assert.include(blocked.message, "styles/intro.mov");
          assert.include(blocked.message, "assets/");
        }
        assert.strictEqual(readEdit(root), before);
        NodeFS.rmSync(NodePath.join(root, "styles", "intro.mov"));
        NodeFS.writeFileSync(
          NodePath.join(root, "styles", "huge.json"),
          Buffer.alloc(11 * 1024 * 1024),
        );
        const tooBig = yield* edits
          .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: first.revision })
          .pipe(Effect.flip);
        assert.include(tooBig.message, "too big");
        // Refused changes leave the history as it was: the baseline and the first change.
        assert.strictEqual(historyLog(root)!.entries.length, 2);
        assert.deepEqual(historyObjects(root), namedObjects(root));
      }),
    ),
  );

  it.effect("should keep previous edit when write is interrupted", () => {
    const faults: EditFaults = { failTempRename: false };
    return withProject(
      ({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const first = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const before = readEdit(root);
          faults.failTempRename = true;
          const error = yield* edits
            .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: first.revision })
            .pipe(Effect.flip);
          faults.failTempRename = false;
          assert.strictEqual(error._tag, "EditUnavailableError");
          assert.strictEqual(readEdit(root), before);
          const after = yield* edits.read(projectId);
          assert.strictEqual(after.revision, first.revision);
          assert.deepEqual(after.document, first.document);
          assert.deepEqual(
            NodeFS.readdirSync(root).filter((entry) => entry.endsWith(".tmp")),
            [],
          );
        }),
      faults,
    );
  });

  it.effect("rolls edit.json back when its revision cannot be saved", () => {
    const faults: EditFaults = { failTempRename: false };
    return withProject(
      ({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const first = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const second = yield* edits.apply(projectId, [keep([[0, 30]])], {
            origin: "agent",
            baseRevision: first.revision,
          });
          const before = readEdit(root);
          faults.failTempRenameOf = "project.json";
          const applyError = yield* edits
            .apply(projectId, [keep([[0, 60]])], {
              origin: "agent",
              baseRevision: second.revision,
            })
            .pipe(Effect.flip);
          const undoError = yield* edits.undo(projectId).pipe(Effect.flip);
          delete faults.failTempRenameOf;
          for (const error of [applyError, undoError]) {
            assert.strictEqual(error._tag, "EditUnavailableError");
            assert.include(error.message, "Nothing changed");
          }
          assert.strictEqual(readEdit(root), before);
          const after = yield* edits.read(projectId);
          assert.strictEqual(after.revision, second.revision);
          assert.isTrue(after.canUndo);
        }),
      faults,
    );
  });

  it.effect("still reads an outside change that the media guard would refuse to record", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const applied = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const outside = { ...applied.document, metadata: { note: "outside" } };
        NodeFS.writeFileSync(NodePath.join(root, "edit.json"), JSON.stringify(outside));
        NodeFS.writeFileSync(NodePath.join(root, "styles", "clip.mov"), "not really a movie");
        const read = yield* edits.read(projectId);
        assert.deepEqual(read.document.metadata, { note: "outside" });
        const blocked = yield* edits
          .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: read.revision })
          .pipe(Effect.flip);
        assert.strictEqual(blocked._tag, "EditUnavailableError");
        assert.include(blocked.message, "styles/clip.mov");
      }),
    ),
  );

  it.effect("streams the current edit, then each change", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        const seen: EditSnapshot[] = [];
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* edits.subscribe(projectId).pipe(
          Stream.take(2),
          Stream.runForEach((snapshot) =>
            Effect.sync(() => seen.push(snapshot)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        const applied = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: seen[0]!.revision,
        });
        yield* Fiber.join(fiber);
        assert.deepEqual(
          seen.map((snapshot) => snapshot.revision),
          [applied.revision - 1, applied.revision],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("saves each change in .s7history and touches no git ref, commit or index", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const before = gitState(root);
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        yield* edits.apply(projectId, [keep([[0, 90]])], {
          origin: "agent",
          baseRevision: first.revision,
        });
        assert.deepEqual(gitState(root), before);
        const log = historyLog(root)!;
        assert.strictEqual(log.format, "s7history");
        // No probe until S7V-052: the old git history is still to be looked for later.
        assert.strictEqual(log.legacy, "unchecked");
        assert.deepEqual(
          log.entries.map((entry) => entry.revision),
          [initial.revision, first.revision, first.revision + 1],
        );
        assert.strictEqual(log.cursor, 2);
        // Three edits and three project.json revisions: one object each, nothing else.
        assert.strictEqual(historyObjects(root).length, 6);
        assert.deepEqual(historyObjects(root), namedObjects(root));
      }),
    ),
  );

  it.effect("records, undoes and redoes with PATH empty and no .git", () => {
    const spawns = { count: 0 };
    return withProject(
      ({ projectId, edits, root }) =>
        Effect.gen(function* () {
          NodeFS.rmSync(NodePath.join(root, ".git"), { recursive: true, force: true });
          const path = process.env.PATH;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              process.env.PATH = "";
              spawns.count = 0;
            }),
            () =>
              Effect.sync(() => {
                process.env.PATH = path;
              }),
          );
          let snapshot = yield* edits.read(projectId);
          const texts: string[] = [];
          for (const ops of [[...setup, keep([[0, 300]])], [keep([[0, 90]])], [keep([[0, 30]])]]) {
            snapshot = yield* edits.apply(projectId, ops, {
              origin: "agent",
              baseRevision: snapshot.revision,
            });
            texts.push(readEdit(root));
          }
          yield* edits.undo(projectId);
          yield* edits.undo(projectId);
          assert.strictEqual(readEdit(root), texts[0]);
          const redone = yield* edits.redo(projectId);
          assert.strictEqual(readEdit(root), texts[1]);
          assert.isTrue(redone.canUndo && redone.canRedo);
          assert.strictEqual(spawns.count, 0);
          assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".git")));
        }).pipe(Effect.scoped),
      undefined,
      { spawns },
    );
  });

  it.effect("guards the tracked folders without git", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        NodeFS.rmSync(NodePath.join(root, ".git"), { recursive: true, force: true });
        const initial = yield* edits.read(projectId);
        // Untracked folders are never checked, however large or media-like their files are.
        NodeFS.writeFileSync(NodePath.join(root, "assets", "clip.mov"), Buffer.alloc(11 << 20));
        NodeFS.mkdirSync(NodePath.join(root, ".s7cache", "proxies"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, ".s7cache", "proxies", "clip.mp4"), "proxy");
        NodeFS.writeFileSync(NodePath.join(root, "stray.wav"), "not tracked");
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const log = historyLog(root);
        const refuse = Effect.fnUntraced(function* (file: string, contents: string | Buffer) {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(root, file), contents);
          const before = readEdit(root);
          const error = yield* edits
            .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: first.revision })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "EditUnavailableError");
          if (error._tag === "EditUnavailableError") {
            assert.strictEqual(error.reason, "media-in-tracked-folder");
          }
          assert.include(error.message, file);
          assert.strictEqual(readEdit(root), before);
          assert.deepEqual(historyLog(root), log);
          NodeFS.rmSync(NodePath.join(root, file));
        });
        yield* refuse("styles/intro.MOV", "not really a movie");
        yield* refuse("styles/deep/fonts/theme.m4a", "sound");
        const readme = NodeFS.readFileSync(NodePath.join(root, "README.md"));
        yield* refuse("README.md", Buffer.alloc(11 << 20));
        NodeFS.writeFileSync(NodePath.join(root, "README.md"), readme);
        const allowed = yield* edits.apply(projectId, [keep([[0, 30]])], {
          origin: "agent",
          baseRevision: first.revision,
        });
        assert.isAbove(allowed.revision, first.revision);
      }),
    ),
  );

  it.effect("keeps undo usable after a crash between objects and log", () => {
    const faults: EditFaults = { failTempRename: false };
    return withProject(
      ({ projectId, edits, root, store }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const setupDone = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const start = readEdit(root);
          const first = yield* edits.apply(projectId, [keep([[0, 300]])], {
            origin: "agent",
            baseRevision: setupDone.revision,
          });
          const afterFirst = readEdit(root);
          const log = historyLog(root);
          faults.failTempRenameOf = "log.json";
          const error = yield* edits
            .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: first.revision })
            .pipe(Effect.flip);
          delete faults.failTempRenameOf;
          assert.strictEqual(error._tag, "EditUnavailableError");
          // The previous log is in place, the edit went back, and the new objects are orphans.
          assert.deepEqual(historyLog(root), log);
          assert.strictEqual(readEdit(root), afterFirst);
          const orphans = historyObjects(root).filter((name) => !namedObjects(root).includes(name));
          assert.strictEqual(orphans.length, 2);

          const read = yield* edits.read(projectId);
          assert.strictEqual(read.revision, first.revision);
          yield* edits.undo(projectId);
          assert.strictEqual(readEdit(root), start);
          yield* edits.redo(projectId);
          assert.strictEqual(readEdit(root), afterFirst);
          const next = yield* edits.apply(projectId, [keep([[0, 60]])], {
            origin: "agent",
            baseRevision: (yield* edits.read(projectId)).revision,
          });
          assert.isTrue(next.canUndo);

          const collected = yield* store.collect(root, yield* store.readLog(root));
          assert.strictEqual(collected.removedObjects, 2);
          assert.deepEqual(historyObjects(root), namedObjects(root));
        }),
      faults,
    );
  });

  it.effect("starts a fresh history from a damaged log", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const current = readEdit(root);
        NodeFS.writeFileSync(NodePath.join(root, ".s7history", "log.json"), "{ garbage");
        const read = yield* edits.read(projectId);
        assert.isFalse(read.canUndo);
        assert.strictEqual(read.revision, first.revision);
        const next = yield* edits.apply(projectId, [keep([[0, 30]])], {
          origin: "agent",
          baseRevision: read.revision,
        });
        const log = historyLog(root)!;
        assert.strictEqual(log.entries.length, 2);
        assert.isTrue(next.canUndo);
        const undone = yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), current);
        assert.isFalse(undone.canUndo);
      }),
    ),
  );

  it.effect("refuses a change, and keeps the history, while the log cannot be read", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const before = readEdit(root);
        const log = historyLog(root);
        const logFile = NodePath.join(root, ".s7history", "log.json");
        NodeFS.chmodSync(logFile, 0o000);
        const error = yield* edits
          .apply(projectId, [keep([[0, 30]])], { origin: "agent", baseRevision: first.revision })
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => NodeFS.chmodSync(logFile, 0o644))));
        assert.strictEqual(error._tag, "EditUnavailableError");
        assert.include(error.message, "Could not read the undo history");
        assert.strictEqual(readEdit(root), before);
        assert.deepEqual(historyLog(root), log);
        const undone = yield* edits.undo(projectId);
        assert.isFalse(undone.canUndo);
      }),
    ),
  );

  it.effect("keeps 200 steps and removes the objects of dropped ones", () =>
    withProject(({ projectId, edits, root, history }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        const first = yield* edits.apply(projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const base = readEdit(root);
        // 204 more steps recorded straight into the history: 206 in all, 6 past the cap.
        for (let n = 1; n <= 204; n++) {
          yield* history.record(root, first.revision + n, base.replace(/\n\}\n$/u, `,"n":${n}}\n`));
        }
        const log = historyLog(root)!;
        assert.strictEqual(log.entries.length, 200);
        assert.strictEqual(log.cursor, 199);
        assert.strictEqual(log.entries[0]!.seq, 7);
        assert.strictEqual(log.entries.at(-1)!.seq, 206);
        assert.deepEqual(historyObjects(root), namedObjects(root));
      }),
    ),
  );

  it.effect("drops the redo branch on a new change; its versions keep their objects", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        let snapshot = yield* edits.read(projectId);
        for (const ops of [[...setup, keep([[0, 300]])], [keep([[0, 90]])], [keep([[0, 30]])]]) {
          snapshot = yield* edits.apply(projectId, ops, {
            origin: "agent",
            baseRevision: snapshot.revision,
          });
        }
        const stale = historyLog(root)!.entries.slice(2);
        yield* edits.undo(projectId);
        const undone = yield* edits.undo(projectId);
        assert.isTrue(undone.canRedo);
        const changed = yield* edits.apply(projectId, [keep([[0, 120]])], {
          origin: "agent",
          baseRevision: undone.revision,
        });
        assert.isFalse(changed.canRedo);
        const log = historyLog(root)!;
        assert.strictEqual(log.entries.length, 3);
        assert.notInclude(
          log.entries.map((entry) => entry.seq),
          stale[0]!.seq,
        );
        // S7V-069: the undone changes are still listed as versions, so their objects stay.
        const versions = log.versions ?? [];
        assert.deepEqual(
          versions.map((version) => version.n),
          [1, 2, 3, 4, 5, 6],
        );
        for (const entry of stale) {
          const id = `${entry.files["edit.json"]}.json.gz`;
          assert.include(historyObjects(root), id);
        }
        assert.deepEqual(historyObjects(root), namedObjects(root));
      }),
    ),
  );

  it.effect("refuses a project that is not an edit project", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        NodeFS.rmSync(NodePath.join(root, "project.json"));
        const error = yield* edits.read(projectId).pipe(Effect.flip);
        assert.strictEqual(error.reason, "not-an-edit-project");
        const missing = yield* edits.read(ProjectId.make("missing")).pipe(Effect.flip);
        assert.strictEqual(missing.reason, "unknown-project");
      }),
    ),
  );

  // S7V-054: an outside edit.json is kept only when valid and adding no media file.
  describe("outside changes", () => {
    const refusedFiles = (root: string) => {
      const folder = NodePath.join(root, ".s7history", "refused");
      return NodeFS.existsSync(folder)
        ? NodeFS.readdirSync(folder)
            .toSorted()
            .map((name) => ({
              name,
              text: NodeFS.readFileSync(NodePath.join(folder, name), "utf8"),
            }))
        : [];
    };
    const writeOutside = (root: string, text: string) =>
      NodeFS.writeFileSync(NodePath.join(root, "edit.json"), text);
    const desktopClip = {
      ...media,
      id: "desk",
      path: undefined,
      reference: "/Users/someone/Desktop/private.mov",
    };
    const { path: _unused, ...desktopReference } = desktopClip;

    it.effect.each([
      { label: "a reference anywhere on the Mac", added: desktopReference },
      {
        label: "a path inside the project",
        added: { ...media, id: "copied", path: "assets/copied.mov" },
      },
    ])("refuses an outside edit that adds $label and puts back the last edit", ({ added }) =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const applied = yield* edits.apply(projectId, [...setup, keep([[0, 300]])], {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const accepted = readEdit(root);
          const logBefore = historyLog(root);
          const outside = JSON.stringify({
            ...applied.document,
            media: [...applied.document.media, added],
          });
          writeOutside(root, outside);
          const error = yield* edits.read(projectId).pipe(Effect.flip);
          assert.strictEqual(error.reason, "outside-change-refused");
          assert.include(error.explanation, "not added through Assets or chat");
          assert.strictEqual(readEdit(root), accepted);
          assert.deepEqual(historyLog(root), logBefore);
          assert.deepEqual(
            refusedFiles(root).map((file) => file.text),
            [outside],
          );
          assert.match(refusedFiles(root)[0]!.name, /^\d+-edit\.json$/u);
          const next = yield* edits.read(projectId);
          assert.deepEqual(next.document, applied.document);
          assert.strictEqual(next.revision, applied.revision);
          assert.isTrue(next.canUndo);
        }),
      ),
    );

    it.effect.each([
      { label: "not valid JSON", text: "{ broken" },
      {
        label: "not a valid edit",
        text: JSON.stringify({ version: 1, fps: { num: 30, den: 1 }, media: "everything" }),
      },
    ])("refuses an outside edit that is $label", ({ text }) =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const applied = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const accepted = readEdit(root);
          writeOutside(root, text);
          const error = yield* edits.read(projectId).pipe(Effect.flip);
          assert.strictEqual(error.reason, "outside-change-refused");
          assert.include(error.explanation, "could not be read");
          assert.strictEqual(readEdit(root), accepted);
          assert.deepEqual(
            refusedFiles(root).map((file) => file.text),
            [text],
          );
          assert.deepEqual((yield* edits.read(projectId)).document, applied.document);
        }),
      ),
    );

    it.effect("refuses with no history yet and leaves the starting edit", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const starting = readEdit(root);
          const initial = yield* edits.read(projectId);
          const outside = JSON.stringify({ ...initial.document, media: [desktopReference] });
          writeOutside(root, outside);
          const error = yield* edits.read(projectId).pipe(Effect.flip);
          assert.strictEqual(error.reason, "outside-change-refused");
          assert.include(error.explanation, "back to how it started");
          assert.strictEqual(readEdit(root), starting);
          assert.deepEqual(
            refusedFiles(root).map((file) => file.text),
            [outside],
          );
          writeOutside(root, "{ broken");
          assert.strictEqual(
            (yield* edits.read(projectId).pipe(Effect.flip)).reason,
            "outside-change-refused",
          );
          const read = yield* edits.read(projectId);
          assert.deepEqual(read.document, initial.document);
          assert.isFalse(read.canUndo);
          // A valid change with no media is kept, and becomes what a later refusal puts back.
          const mine = JSON.stringify({ ...initial.document, metadata: { note: "mine" } });
          writeOutside(root, mine);
          assert.deepEqual((yield* edits.read(projectId)).document.metadata, { note: "mine" });
          writeOutside(root, outside);
          const again = yield* edits.read(projectId).pipe(Effect.flip);
          assert.strictEqual(again.reason, "outside-change-refused");
          assert.include(again.explanation, "last saved version");
          assert.strictEqual(readEdit(root), mine);
          assert.strictEqual((yield* edits.read(projectId)).revision, 0);
        }),
      ),
    );

    it.effect("checks a log from a git import, which has no knownEdit, against its cursor", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const applied = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const accepted = readEdit(root);
          const { knownEdit: _known, ...imported } = historyLog(root)!;
          NodeFS.writeFileSync(
            NodePath.join(root, ".s7history", "log.json"),
            JSON.stringify(imported),
          );
          assert.deepEqual((yield* edits.read(projectId)).document, applied.document);
          writeOutside(
            root,
            JSON.stringify({
              ...applied.document,
              media: [...applied.document.media, desktopReference],
            }),
          );
          const error = yield* edits.read(projectId).pipe(Effect.flip);
          assert.strictEqual(error.reason, "outside-change-refused");
          assert.strictEqual(readEdit(root), accepted);
        }),
      ),
    );

    it.effect("a second refused write keeps both rejected files", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          yield* edits.read(projectId);
          writeOutside(root, "{ first");
          yield* edits.read(projectId).pipe(Effect.flip);
          writeOutside(root, "{ second");
          yield* edits.read(projectId).pipe(Effect.flip);
          assert.sameMembers(
            refusedFiles(root).map((file) => file.text),
            ["{ first", "{ second"],
          );
        }),
      ),
    );

    it.effect("a T3 turn revert to an earlier edit is still accepted", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const withClip = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const earlier = readEdit(root);
          const removed = yield* edits.apply(projectId, [{ _tag: "removeMedia", mediaId: "cam" }], {
            origin: "timeline",
            baseRevision: withClip.revision,
          });
          assert.isEmpty(removed.document.media);
          // The clip is not in the last edit, but this exact text was accepted before.
          writeOutside(root, earlier);
          const read = yield* edits.read(projectId);
          assert.deepEqual(read.document, withClip.document);
          assert.isAbove(read.revision, removed.revision);
          assert.isEmpty(refusedFiles(root));
        }),
      ),
    );

    it.effect("puts back the edit an undo wrote, with the clips it kept", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const first = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          yield* edits.apply(
            projectId,
            [
              { _tag: "putMedia", media: { ...media, id: "mic", path: "assets/mic.m4a" } },
              keep([[0, 300]]),
            ],
            { origin: "agent", baseRevision: first.revision },
          );
          const undone = yield* edits.undo(projectId);
          assert.include(
            undone.document.media.map((entry) => entry.id),
            "mic",
          );
          const accepted = readEdit(root);
          writeOutside(root, JSON.stringify({ ...undone.document, media: [desktopReference] }));
          yield* edits.read(projectId).pipe(Effect.flip);
          assert.strictEqual(readEdit(root), accepted);
        }),
      ),
    );

    it.effect("a refused write publishes one snapshot with the notice", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          const applied = yield* edits.apply(projectId, setup, {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const seen: EditSnapshot[] = [];
          const subscribed = yield* Deferred.make<void>();
          const fiber = yield* edits.subscribe(projectId).pipe(
            Stream.take(3),
            Stream.runForEach((snapshot) =>
              Effect.sync(() => seen.push(snapshot)).pipe(
                Effect.andThen(Deferred.succeed(subscribed, undefined)),
              ),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(subscribed);
          writeOutside(root, "{ broken");
          const error = yield* edits.read(projectId).pipe(Effect.flip);
          // The next reads find the restored edit and publish nothing more.
          yield* edits.read(projectId);
          yield* edits.read(projectId);
          const next = yield* edits.apply(projectId, [keep([[0, 30]])], {
            origin: "agent",
            baseRevision: applied.revision,
          });
          yield* Fiber.join(fiber);
          assert.deepEqual(
            seen.map((snapshot) => [snapshot.revision, snapshot.notice]),
            [
              [applied.revision, undefined],
              [applied.revision, error.explanation],
              [next.revision, undefined],
            ],
          );
          assert.deepEqual(seen[1]!.document, applied.document);
        }).pipe(Effect.scoped),
      ),
    );

    it.effect("a subscriber whose first read finds the refusal gets the notice first", () =>
      withProject(({ projectId, edits, root }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          writeOutside(root, "{ broken");
          const [first] = yield* edits.subscribe(projectId).pipe(Stream.take(1), Stream.runCollect);
          assert.include(first!.notice, "could not be read");
          assert.deepEqual(first!.document, initial.document);
        }),
      ),
    );
  });
});
