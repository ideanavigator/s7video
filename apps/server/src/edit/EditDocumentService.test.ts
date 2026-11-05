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
import { type EditFaults, git, isIgnored, layerEditTest } from "./editHarness.testkit.ts";

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
  }) => Effect.Effect<A, E>,
  faults?: EditFaults,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-edit-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const created = yield* folders.createNamedProject({ name: "Edit test" });
      return yield* body({ projectId: created.projectId, root: created.workspaceRoot, edits });
    }).pipe(Effect.provide(layerEditTest(baseDir, faults)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

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
        const objects = git(root, "rev-list", "--objects", "--all");
        assert.notInclude(objects, "stray-clip.mp4");
        assert.notInclude(objects, "huge.json");
        assert.notInclude(objects, "intro.mov");
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
});
