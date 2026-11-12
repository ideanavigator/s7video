// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder directly.
/** S7V-069: numbered versions of a project's edit, beside the undo steps in `.s7history/`. */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EditOp, type ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { wordEditOps } from "@t3tools/shared/editWordCuts";
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

  // S7V-034: one timeline gesture is one version by you, one counted line however many items.
  it.effect("a timeline gesture makes one version by you, with one counted line", () =>
    withProject(({ projectId, edits }) =>
      Effect.gen(function* () {
        yield* change(
          edits,
          projectId,
          [
            ...setup,
            keep([
              [0, 30],
              [60, 30],
              [120, 30],
            ]),
          ],
          {
            origin: "agent",
            reply: chatA,
          },
        );
        const before = (yield* edits.versions(projectId)).length;
        yield* change(
          edits,
          projectId,
          [
            { _tag: "moveItem", itemId: "v1", start: 200 },
            { _tag: "moveItem", itemId: "v2", start: 230 },
            { _tag: "moveItem", itemId: "v3", start: 260 },
          ],
          { origin: "timeline" },
        );
        yield* change(
          edits,
          projectId,
          [{ _tag: "trimItem", itemId: "v1", edge: "end", frame: 220 }],
          {
            origin: "timeline",
          },
        );
        yield* change(
          edits,
          projectId,
          [{ _tag: "deleteItem", itemIds: ["v2", "v3"], ripple: true }],
          { origin: "timeline" },
        );
        const versions = yield* edits.versions(projectId);
        assert.strictEqual(versions.length, before + 3);
        assert.deepEqual(
          versions
            .slice(0, 3)
            .map(({ author, changes, threadId }) => ({ author, changes, threadId })),
          [
            { author: "you", changes: ["Deleted 2 items from the timeline"], threadId: undefined },
            { author: "you", changes: ["Trimmed an item"], threadId: undefined },
            { author: "you", changes: ["Moved 3 items"], threadId: undefined },
          ],
        );
      }),
    ),
  );

  // S7V-038: a text cut or restore is one version, worded as one change; agent, timeline and text
  // edits undo one at a time, in order, back to the exact bytes.
  it.effect("text edits interleave with agent and timeline edits and undo in order", () =>
    withProject(({ projectId, root, edits }) =>
      Effect.gen(function* () {
        // Ten words of 20 frames with 10-frame gaps, from frame 10.
        const words = Array.from({ length: 10 }, (_, index) => ({
          start: 10 + index * 30,
          end: 30 + index * 30,
        }));
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        const bytes = [readEdit(root)];
        const text = (action: "cut" | "restore", first: number, last: number) =>
          Effect.gen(function* () {
            const current = yield* edits.read(projectId);
            const edit = wordEditOps(current.document, "cam", words, { first, last }, action);
            assert.strictEqual(edit._tag, action);
            if (edit._tag !== "cut" && edit._tag !== "restore") return;
            yield* edits.apply(projectId, edit.ops, {
              origin: "transcript",
              baseRevision: current.revision,
            });
            bytes.push(readEdit(root));
          });
        yield* text("cut", 2, 3);
        // The agent trims the end; the timeline moves the last part right, leaving a gap.
        const cut = yield* edits.read(projectId);
        const last = cut.document.tracks[0]!.items.at(-1)!;
        yield* change(
          edits,
          projectId,
          [
            {
              _tag: "trimItem",
              itemId: last.id,
              edge: "end",
              frame: last.start + last.duration - 30,
            },
          ],
          { origin: "agent", reply: replyOf("thread-a", "run-a2") },
        );
        bytes.push(readEdit(root));
        yield* change(
          edits,
          projectId,
          [{ _tag: "moveItem", itemId: last.id, start: last.start + 20 }],
          { origin: "timeline" },
        );
        bytes.push(readEdit(root));
        yield* text("restore", 2, 2);
        const versions = yield* edits.versions(projectId);
        assert.deepEqual(
          versions.slice(0, 4).map(({ author, changes }) => ({ author, changes })),
          [
            { author: "you", changes: ["Put back words in the transcript"] },
            { author: "you", changes: ["Moved an item"] },
            { author: "assistant", changes: ["Trimmed an item"] },
            { author: "you", changes: ["Cut words in the transcript"] },
          ],
        );
        for (let step = bytes.length - 2; step >= 0; step -= 1) {
          yield* edits.undo(projectId);
          assert.strictEqual(readEdit(root), bytes[step]);
        }
      }),
    ),
  );

  // S7V-032 AC-8: at least three agent, three timeline and three transcript edits, interleaved
  // in one session. Each undo gives back the bytes before that change; each redo the bytes after.
  it.effect("interleaved undo and redo across agent, timeline and transcript edits", () =>
    withProject(({ projectId, root, edits }) =>
      Effect.gen(function* () {
        // Ten words of 20 frames with 10-frame gaps, from frame 10.
        const words = Array.from({ length: 10 }, (_, index) => ({
          start: 10 + index * 30,
          end: 30 + index * 30,
        }));
        // The clip is in Assets first: undo keeps library clips, so a session that starts
        // before the import could not get back the exact first bytes (by design).
        yield* change(edits, projectId, [{ _tag: "putMedia", media }], { origin: "import" });
        const bytes = [readEdit(root)];
        // Agent edits in one reply fold into one version (S7V-069), so each agent edit here
        // comes from its own reply: then each is its own version as well as its own undo step.
        let run = 0;
        const agent = (ops: ReadonlyArray<EditOp>) =>
          change(edits, projectId, ops, {
            origin: "agent",
            reply: replyOf("thread-a", `run-a${++run}`),
          }).pipe(Effect.tap(() => Effect.sync(() => bytes.push(readEdit(root)))));
        /** One timeline gesture, built from the current edit's video items. */
        const timeline = (
          gesture: (
            items: ReadonlyArray<{ id: string; start: number; duration: number }>,
          ) => EditOp,
        ) =>
          Effect.gen(function* () {
            const current = yield* edits.read(projectId);
            const items = current.document.tracks.find((track) => track.id === "V1")!.items;
            yield* edits.apply(projectId, [gesture(items)], {
              origin: "timeline",
              baseRevision: current.revision,
            });
            bytes.push(readEdit(root));
          });
        /** A transcript cut or restore of words `first`…`last`, the way S7V-038 sends it. */
        const text = (action: "cut" | "restore", first: number, last: number) =>
          Effect.gen(function* () {
            const current = yield* edits.read(projectId);
            const edit = wordEditOps(current.document, "cam", words, { first, last }, action);
            assert.strictEqual(edit._tag, action, `${action} words ${first}–${last}`);
            if (edit._tag !== "cut" && edit._tag !== "restore") return;
            yield* edits.apply(projectId, edit.ops, {
              origin: "transcript",
              baseRevision: current.revision,
            });
            bytes.push(readEdit(root));
          });

        yield* agent([setup[1]!, keep([[0, 300]])]);
        yield* text("cut", 2, 3);
        yield* timeline((items) => ({
          _tag: "moveItem",
          itemId: items.at(-1)!.id,
          start: items.at(-1)!.start + 20,
        }));
        yield* agent([{ _tag: "addTrack", track: { kind: "caption", id: "C1", items: [] } }]);
        yield* text("cut", 6, 6);
        yield* timeline((items) => ({
          _tag: "trimItem",
          itemId: items[0]!.id,
          edge: "end",
          frame: items[0]!.start + items[0]!.duration - 5,
        }));
        yield* agent([
          {
            _tag: "setCaptions",
            trackId: "C1",
            captions: [{ start: 0, duration: 15, text: "hi" }],
          },
        ]);
        yield* text("restore", 2, 2);
        yield* timeline((items) => ({
          _tag: "splitItem",
          itemId: items.at(-1)!.id,
          atFrame: items.at(-1)!.start + 10,
        }));
        yield* agent([
          { _tag: "setMarkers", markers: [{ id: "mk", start: 5, duration: 0, label: "Hook" }] },
        ]);
        yield* timeline((items) => ({
          _tag: "deleteItem",
          itemIds: [items.at(-1)!.id],
          ripple: true,
        }));

        // 4 agent, 4 timeline and 3 transcript edits: 11 changes, each with different bytes.
        assert.strictEqual(bytes.length, 12);
        assert.strictEqual(new Set(bytes).size, bytes.length);
        const versions = yield* edits.versions(projectId);
        assert.deepEqual(
          versions.slice(0, 11).map(({ author }) => author),
          // Newest first; the session ran agent, text, timeline ×3, then agent, timeline.
          [
            "you",
            "assistant",
            "you",
            "you",
            "assistant",
            "you",
            "you",
            "assistant",
            "you",
            "you",
            "assistant",
          ],
        );
        for (let step = bytes.length - 2; step >= 0; step -= 1) {
          yield* edits.undo(projectId);
          assert.strictEqual(readEdit(root), bytes[step], `undo back to step ${step}`);
        }
        for (let step = 1; step < bytes.length; step += 1) {
          yield* edits.redo(projectId);
          assert.strictEqual(readEdit(root), bytes[step], `redo to step ${step}`);
        }
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
        assert.include(error.message, 'Making v1 main would clash with the clip "a"');
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

/** S7V-070: versions named in chat ("v12", "12", "first cut") by `video_versions` and restore. */
describe("versions named in chat", () => {
  const record = (n: number, tag?: string): EditSnapshotStore.EditVersionRecord => ({
    n,
    files: { "edit.json": "ab".repeat(32), "project.json": "cd".repeat(32) },
    revision: n,
    at: n,
    author: "you",
    changes: [`change ${n}`],
    ...(tag === undefined ? {} : { tag }),
  });

  it("reads a number first, then a name, ignoring case and spacing", () => {
    const versions = [record(1, "First Cut"), record(2), record(5, "12"), record(12)];
    const found = (ref: string) => EditHistoryService.findVersionRef(versions, ref);
    assert.deepEqual(found("v12"), { _tag: "found", version: versions[3]! });
    assert.deepEqual(found(" V 12 "), { _tag: "found", version: versions[3]! });
    // A name that reads as a number loses to the number, and the reply names the other version.
    assert.deepEqual(found("12"), { _tag: "found", version: versions[3]!, alsoNamed: 5 });
    assert.deepEqual(found("first  cut"), { _tag: "found", version: versions[0]! });
    assert.deepEqual(found("FIRST CUT"), { _tag: "found", version: versions[0]! });
    assert.deepEqual(found("v99"), { _tag: "missing", n: 99 });
    assert.deepEqual(found("nope"), { _tag: "missing" });
    assert.deepEqual(found("  "), { _tag: "missing" });
    // With no v12, the name "12" finds its version.
    assert.deepEqual(EditHistoryService.findVersionRef(versions.slice(0, 3), "12"), {
      _tag: "found",
      version: versions[2]!,
    });
  });

  it.effect("a restore by name from a second chat adds the next version and keeps the rest", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        const v1Edit = readEdit(root);
        yield* edits.tagVersion(projectId, 1, "First cut");
        yield* change(edits, projectId, [keep([[0, 90]])], {
          origin: "agent",
          reply: replyOf("thread-a", "run-a2"),
        });

        const details = yield* edits.findVersion(projectId, "first cut");
        assert.strictEqual(details.version.n, 1);
        assert.isFalse(details.version.current);
        assert.deepEqual(details.document.tracks, JSON.parse(v1Edit).tracks);

        const before = yield* edits.versions(projectId);
        const current = yield* edits.read(projectId);
        const chatB = replyOf("thread-b", "run-b1");
        const restored = yield* edits.restoreVersionRef(projectId, "First Cut", {
          reply: chatB,
          baseRevision: current.revision,
        });
        assert.isTrue(restored.changed);
        assert.strictEqual(restored.version.n, 1);
        assert.strictEqual(restored.snapshot.version, 3);
        assert.strictEqual(readEdit(root), v1Edit);
        const after = yield* edits.versions(projectId);
        assert.deepInclude(after[0], {
          n: 3,
          author: "assistant",
          threadId: chatB.threadId,
          changes: ["Restored from v1"],
          restoredFrom: 1,
          current: true,
        });
        assert.deepEqual(
          after.slice(1),
          before.map((version) => ({ ...version, current: false })),
        );
      }),
    ),
  );

  it.effect("restoring the version that is already the edit writes nothing", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          reply: chatA,
        });
        const current = yield* edits.read(projectId);
        const editBefore = readEdit(root);
        const logBefore = historyLog(root);
        for (const ref of ["v1", "1"]) {
          const same = yield* edits.restoreVersionRef(projectId, ref, {
            reply: replyOf("thread-b", "run-b1"),
            baseRevision: current.revision,
          });
          assert.isFalse(same.changed);
          assert.isTrue(same.version.current);
          assert.strictEqual(same.snapshot.revision, current.revision);
        }
        assert.strictEqual(readEdit(root), editBefore);
        assert.deepEqual(historyLog(root), logBefore);
        assert.strictEqual((yield* edits.versions(projectId)).length, 1);
      }),
    ),
  );

  it.effect("an unknown number or name is a plain unknown-version refusal", () =>
    withProject(({ projectId, edits, root }) =>
      Effect.gen(function* () {
        yield* change(edits, projectId, [...setup, keep([[0, 300]])], { origin: "import" });
        const current = yield* edits.read(projectId);
        const editBefore = readEdit(root);
        for (const [ref, explanation] of [
          ["v999", "There is no version v999 in this project."],
          ["nope", 'No version in this project is named "nope".'],
          ["  ", "Say which version: v12 or its name."],
        ] as const) {
          for (const attempt of [
            Effect.flip(edits.findVersion(projectId, ref)),
            Effect.flip(
              edits.restoreVersionRef(projectId, ref, { baseRevision: current.revision }),
            ),
          ]) {
            const error = yield* attempt;
            assert.strictEqual(
              error._tag === "EditUnavailableError" && error.reason,
              "unknown-version",
            );
            assert.strictEqual(
              error._tag === "EditUnavailableError" && error.explanation,
              explanation,
            );
          }
        }
        assert.strictEqual(readEdit(root), editBefore);
      }),
    ),
  );
});
