// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder directly.
/** S7V-069: numbered versions of a project's edit, beside the undo steps in `.s7history/`. */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EditOp, type ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import * as EditHistoryService from "./EditHistoryService.ts";
import { historyLog, historyObjects, layerEditTest } from "./editHarness.testkit.ts";
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

const replyOf = (thread: string, run: string) => ({
  threadId: ThreadId.make(thread),
  runId: RunId.make(run),
});
const chatA = replyOf("thread-a", "run-a1");

const withProject = <A, E>(
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly store: EditSnapshotStore.EditSnapshotStore["Service"];
    readonly history: EditHistoryService.EditHistoryService["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-versions-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const created = yield* folders.createNamedProject({ name: "Versions test" });
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        edits: yield* EditDocumentService.EditDocumentService,
        store: yield* EditSnapshotStore.EditSnapshotStore,
        history: yield* EditHistoryService.EditHistoryService,
      });
    }).pipe(Effect.provide(layerEditTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

/** Applies `ops` on the current revision. */
const change = (
  edits: EditDocumentService.EditDocumentService["Service"],
  projectId: ProjectId,
  ops: ReadonlyArray<EditOp>,
  options: Omit<
    Parameters<EditDocumentService.EditDocumentService["Service"]["apply"]>[2],
    "baseRevision"
  >,
) =>
  edits
    .read(projectId)
    .pipe(
      Effect.flatMap((snapshot) =>
        edits.apply(projectId, ops, { ...options, baseRevision: snapshot.revision }),
      ),
    );

describe("edit versions", () => {
  it.effect("one reply with two edits makes one version listing both, in order", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
          summary: "Removed 14.2 s of silence in 26 cuts",
        });
        const second = yield* change(edits, projectId, [keep([[0, 90]])], {
          origin: "agent",
          reply: chatA,
          summary: "Added captions",
        });
        const versions = yield* edits.versions(projectId);
        assert.strictEqual(versions.length, 1);
        assert.deepInclude(versions[0], {
          n: 1,
          author: "assistant",
          threadId: chatA.threadId,
          runId: chatA.runId,
          changes: ["Removed 14.2 s of silence in 26 cuts", "Added captions"],
          current: true,
          revision: second.revision,
        });
        assert.strictEqual(second.version, 1);
      }),
    ),
  );

  it.effect("a reply that changes nothing makes no version and uses no number", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        // The same bytes again, from a later reply: no change, no version.
        yield* change(edits, projectId, [keep([[0, 300]])], {
          origin: "agent",
          reply: replyOf("thread-a", "run-a2"),
        });
        yield* change(edits, projectId, [], {
          origin: "agent",
          reply: replyOf("thread-a", "run-a3"),
        });
        yield* change(edits, projectId, [keep([[0, 60]])], {
          origin: "agent",
          reply: replyOf("thread-a", "run-a4"),
        });
        const versions = yield* edits.versions(projectId);
        assert.deepEqual(
          versions.map((version) => version.n),
          [2, 1],
        );
        assert.strictEqual(versions[0]!.runId, "run-a4");
      }),
    ),
  );

  it.effect("an Editor import makes a version by you, worded from its ops", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [{ _tag: "putMedia", media }], { origin: "import" });
        yield* change(edits, projectId, [{ _tag: "removeMedia", mediaId: "cam" }], {
          origin: "import",
        });
        const versions = yield* edits.versions(projectId);
        assert.deepEqual(
          versions.map(({ n, author, changes, threadId }) => ({ n, author, changes, threadId })),
          [
            { n: 2, author: "you", changes: ["Removed a clip from Assets"], threadId: undefined },
            { n: 1, author: "you", changes: ["Added a clip to Assets"], threadId: undefined },
          ],
        );
      }),
    ),
  );

  it.effect("undo from chat makes a version by the assistant; from the Editor, by you", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        yield* change(edits, projectId, [keep([[0, 90]])], {
          origin: "agent",
          reply: replyOf("thread-a", "run-a2"),
        });
        const undoReply = replyOf("thread-a", "run-a3");
        const step = yield* edits.step(projectId, "undo", { reply: undoReply });
        assert.isTrue(step.changed);
        yield* edits.redo(projectId);
        const versions = yield* edits.versions(projectId);
        assert.deepEqual(
          versions
            .slice(0, 2)
            .map(({ n, author, changes, runId }) => ({ n, author, changes, runId })),
          [
            { n: 4, author: "you", changes: ["Redid a change"], runId: undefined },
            {
              n: 3,
              author: "assistant",
              changes: ["Undid the last change"],
              runId: undoReply.runId,
            },
          ],
        );
      }),
    ),
  );

  it.effect("make current adds a version equal to the old one, keeps the rest, and undoes", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        const v1Edit = readEdit(root);
        yield* change(edits, projectId, [keep([[0, 90]])], {
          origin: "agent",
          reply: replyOf("thread-a", "run-a2"),
        });
        const v2Edit = readEdit(root);
        const before = yield* edits.versions(projectId);
        const current = yield* edits.read(projectId);

        // Preview reads the version without writing anything.
        const logBefore = historyLog(root);
        const preview = yield* edits.versionDocument(projectId, 1);
        assert.deepEqual(preview.document.tracks, JSON.parse(v1Edit).tracks);
        assert.isFalse(preview.version.current);
        assert.strictEqual(readEdit(root), v2Edit);
        assert.deepEqual(historyLog(root), logBefore);

        const stale = yield* edits
          .restoreVersion(projectId, 1, { baseRevision: current.revision - 1 })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "EditConflict");

        const restored = yield* edits.restoreVersion(projectId, 1, {
          baseRevision: current.revision,
        });
        assert.strictEqual(readEdit(root), v1Edit);
        assert.strictEqual(restored.version, 3);
        const after = yield* edits.versions(projectId);
        assert.deepInclude(after[0], {
          n: 3,
          author: "you",
          changes: ["Restored from v1"],
          restoredFrom: 1,
          current: true,
        });
        assert.deepEqual(
          after.slice(1),
          before.map((version) => ({ ...version, current: false })),
        );
        const undone = yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), v2Edit);
        assert.strictEqual(undone.version, 4);

        const missing = yield* edits
          .restoreVersion(projectId, 99, {
            baseRevision: undone.revision,
          })
          .pipe(Effect.flip);
        assert.strictEqual(
          missing._tag === "EditUnavailableError" && missing.reason,
          "unknown-version",
        );
      }),
    ),
  );

  it.effect("make current keeps clips added to Assets since that version", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        const later = { ...media, id: "broll", path: "assets/broll.mp4" };
        yield* change(edits, projectId, [{ _tag: "putMedia", media: later }], { origin: "import" });
        const current = yield* edits.read(projectId);
        const restored = yield* edits.restoreVersion(projectId, 1, {
          baseRevision: current.revision,
        });
        assert.deepEqual(
          restored.document.media.map((entry) => entry.id),
          ["cam", "broll"],
        );
      }),
    ),
  );

  it.effect("make current refuses a clip clash and writes nothing", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        yield* change(
          edits,
          projectId,
          [
            ...setup,
            {
              _tag: "insertItem",
              trackId: "V1",
              item: { id: "a", media: "cam", start: 0, duration: 30, in: 0 },
            },
          ],
          { origin: "agent", reply: chatA },
        );
        yield* change(edits, projectId, [{ _tag: "deleteItem", itemIds: ["a"], ripple: false }], {
          origin: "timeline",
        });
        // A clip in Assets now has the id v1's item uses: ids share one space.
        const clashing = { ...media, id: "a", path: "assets/a.mp4" };
        const current = yield* change(edits, projectId, [{ _tag: "putMedia", media: clashing }], {
          origin: "import",
        });
        const editBefore = readEdit(root);
        const logBefore = NodeFS.readFileSync(
          NodePath.join(root, ".s7history", "log.json"),
          "utf8",
        );
        const error = yield* edits
          .restoreVersion(projectId, 1, { baseRevision: current.revision })
          .pipe(Effect.flip);
        assert.strictEqual(
          error._tag === "EditUnavailableError" && error.reason,
          "library-conflict",
        );
        assert.include(error.message, 'Making v1 current would clash with the clip "a"');
        assert.strictEqual(readEdit(root), editBefore);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(root, ".s7history", "log.json"), "utf8"),
          logBefore,
        );
        assert.strictEqual((yield* edits.versions(projectId)).length, 3);
      }),
    ),
  );

  it.effect("tags are unique per project, can be changed and cleared", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], { origin: "import" });
        yield* change(edits, projectId, [keep([[0, 90]])], { origin: "import" });
        const tagged = yield* edits.tagVersion(projectId, 1, "  first   cut ");
        assert.strictEqual(tagged.tag, "first cut");
        const clash = yield* edits.tagVersion(projectId, 2, "First Cut").pipe(Effect.flip);
        assert.strictEqual(clash.reason, "tag-taken");
        assert.include(clash.explanation, "v1 already has that name");
        // The same version may keep or re-case its own tag.
        assert.strictEqual((yield* edits.tagVersion(projectId, 1, "First cut")).tag, "First cut");
        yield* edits.tagVersion(projectId, 1, "tight cut");
        assert.strictEqual((yield* edits.tagVersion(projectId, 2, "first cut")).tag, "first cut");
        const cleared = yield* edits.tagVersion(projectId, 1, null);
        assert.isUndefined(cleared.tag);
        assert.notProperty(cleared, "tag");
        const unknown = yield* edits.tagVersion(projectId, 7, "x").pipe(Effect.flip);
        assert.strictEqual(unknown.reason, "unknown-version");
      }),
    ),
  );

  it.effect("deleting a version never reuses its number and refuses the current one", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], { origin: "import" });
        yield* change(edits, projectId, [keep([[0, 90]])], { origin: "import" });
        yield* change(edits, projectId, [keep([[0, 30]])], { origin: "import" });
        const current = yield* edits.deleteVersion(projectId, 3).pipe(Effect.flip);
        assert.strictEqual(current.reason, "current-version");
        const left = yield* edits.deleteVersion(projectId, 2);
        assert.deepEqual(
          left.map((version) => version.n),
          [3, 1],
        );
        // A version deleted while also an undo step keeps its objects for undo.
        assert.strictEqual(historyLog(root)!.entries.length, 4);
        yield* edits.deleteVersion(projectId, 3).pipe(Effect.flip);
        yield* change(edits, projectId, [keep([[0, 60]])], { origin: "import" });
        assert.deepEqual(
          (yield* edits.versions(projectId)).map((version) => version.n),
          [4, 3, 1],
        );
        assert.strictEqual(historyLog(root)!.nextVersion, 5);
      }),
    ),
  );

  it.effect("two chats changing the edit at once: one conflicts, retries, both are listed", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        const base = yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "import",
        });
        const chatB = replyOf("thread-b", "run-b1");
        yield* edits.apply(projectId, [keep([[0, 90]])], {
          origin: "agent",
          baseRevision: base.revision,
          reply: chatA,
        });
        const lost = yield* edits
          .apply(projectId, [keep([[0, 60]])], {
            origin: "agent",
            baseRevision: base.revision,
            reply: chatB,
          })
          .pipe(Effect.flip);
        assert.strictEqual(lost._tag, "EditConflict");
        const retried = yield* change(edits, projectId, [keep([[0, 60]])], {
          origin: "agent",
          reply: chatB,
        });
        assert.strictEqual(retried.version, 3);
        assert.deepEqual(
          (yield* edits.versions(projectId)).map(({ n, threadId }) => ({ n, threadId })),
          [
            { n: 3, threadId: chatB.threadId },
            { n: 2, threadId: chatA.threadId },
            { n: 1, threadId: undefined },
          ],
        );
      }),
    ),
  );

  it.effect("an outside change is listed as outside", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        const applied = yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "import",
        });
        NodeFS.writeFileSync(
          NodePath.join(root, "edit.json"),
          JSON.stringify({ ...applied.document, canvas: { width: 1080, height: 1920 } }),
        );
        const read = yield* edits.read(projectId);
        assert.strictEqual(read.version, 2);
        assert.deepInclude((yield* edits.versions(projectId))[0], {
          n: 2,
          author: "outside",
          changes: ["Changed outside the Editor"],
        });
      }),
    ),
  );

  it.effect("every object a version names outlives the 200-step undo cap and collect", () =>
    withProject(({ projectId, edits, root, store, history }) =>
      Effect.gen(function* () {
        const first = yield* change(edits, projectId, setup, { origin: "import" });
        const v1Edit = readEdit(root);
        // 204 more Editor changes straight into the history: 205 versions, 6 steps past the cap.
        for (let n = 1; n <= 204; n++) {
          yield* history.record(
            root,
            first.revision + n,
            v1Edit.replace(/\n\}\n$/u, `,"n":${n}}\n`),
            {
              author: "you",
              change: `Change ${n}`,
            },
          );
        }
        const log = historyLog(root)!;
        assert.strictEqual(log.entries.length, 200);
        assert.strictEqual(log.versions!.length, 205);
        const v1 = log.versions![0]!;
        assert.notInclude(
          log.entries.map((entry) => entry.files["edit.json"]),
          v1.files["edit.json"],
        );
        yield* store.collect(root, log);
        assert.include(historyObjects(root), `${v1.files["edit.json"]}.json.gz`);
        const preview = yield* edits.versionDocument(projectId, 1);
        assert.strictEqual(preview.version.n, 1);
      }),
    ),
  );

  it.effect("a reply's changes stop at ten lines", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, setup, {
          origin: "agent",
          reply: chatA,
          summary: "Line 0",
        });
        for (let n = 1; n <= 12; n++) {
          yield* change(edits, projectId, [keep([[0, 10 * n]])], {
            origin: "agent",
            reply: chatA,
            summary: `Line ${n} ${"x".repeat(300)}`,
          });
        }
        const [version] = yield* edits.versions(projectId);
        assert.strictEqual(version!.changes.length, 10);
        assert.strictEqual(version!.changes.at(-1), "…and more changes");
        assert.isAtMost(version!.changes[1]!.length, 200);
      }),
    ),
  );
});
