// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions stat the project folder.
/**
 * S7V-034: timeline gestures and agent edits share one history on the real edit service and the
 * `.s7history/` store. Each gesture is one `apply` batch, so one step; undo and redo are byte exact.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EditOp, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { historyLog, layerEditTest } from "./editHarness.testkit.ts";

const media = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: 90_000, hasVideo: true, hasAudio: true },
} as const;

const withProject = <A, E>(
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-timeline-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const created = yield* folders.createNamedProject({ name: "Timeline test" });
      return yield* body({ projectId: created.projectId, root: created.workspaceRoot, edits });
    }).pipe(Effect.provide(layerEditTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

/** A cut edit of `count` 30-frame pieces of one clip, end to end, with captions on two of them. */
const cutOps = (count: number): EditOp[] => [
  { _tag: "putMedia", media },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
  {
    _tag: "setKeepRanges",
    trackId: "V1",
    mediaId: "cam",
    ranges: Array.from({ length: count }, (_, index) => ({ in: index * 60, duration: 30 })),
  },
];

/** The gestures the timeline sends: one batch each, origin `timeline`. */
const gestures: ReadonlyArray<(itemIds: ReadonlyArray<string>) => EditOp[]> = [
  (ids) => [{ _tag: "moveItem", itemId: ids.at(-1)!, start: 400 }],
  (ids) => [{ _tag: "trimItem", itemId: ids[0]!, edge: "end", frame: 20 }],
  (ids) => [{ _tag: "trimItem", itemId: ids[1]!, edge: "start", frame: 35 }],
  (ids) => [{ _tag: "splitItem", itemId: ids[2]!, atFrame: 70 }],
  (ids) => [{ _tag: "deleteItem", itemIds: [ids[3]!], ripple: false }],
  (ids) => [{ _tag: "deleteItem", itemIds: [ids[4]!], ripple: true }],
];

/** Agent-style edits: captions and track settings, as the video tools write them. */
const agentEdits: ReadonlyArray<EditOp[]> = [
  [{ _tag: "addTrack", track: { kind: "caption", id: "C1", items: [] } }],
  [{ _tag: "setCaptions", trackId: "C1", captions: [{ start: 0, duration: 15, text: "hi" }] }],
  [{ _tag: "setCaptionStyle", trackId: "C1", style: "s7-box" }],
  [{ _tag: "setTrackProps", trackId: "V1", props: { label: "Main" } }],
  [{ _tag: "setMarkers", markers: [{ id: "mk", start: 5, duration: 0, label: "Hook" }] }],
];

const videoIds = (snapshot: {
  document: { tracks: ReadonlyArray<{ id: string; items: ReadonlyArray<{ id: string }> }> };
}) => snapshot.document.tracks.find((track) => track.id === "V1")!.items.map((item) => item.id);

describe("timeline edits in the shared history (S7V-034)", () => {
  it.effect("interleaves 5 agent edits and 5 gestures; 10 undos and 10 redos are byte exact", () =>
    withProject(({ projectId, root, edits }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        let snapshot = yield* edits.apply(projectId, cutOps(12), {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const texts = [readEdit(root)];
        const stepsBefore = historyLog(root)!.entries.length;
        for (let index = 0; index < 5; index++) {
          snapshot = yield* edits.apply(projectId, agentEdits[index]!, {
            origin: "agent",
            baseRevision: snapshot.revision,
          });
          texts.push(readEdit(root));
          snapshot = yield* edits.apply(projectId, gestures[index]!(videoIds(snapshot)), {
            origin: "timeline",
            baseRevision: snapshot.revision,
          });
          texts.push(readEdit(root));
        }
        // One history step per batch: no per-item or per-op steps.
        assert.strictEqual(historyLog(root)!.entries.length, stepsBefore + 10);
        for (let index = 9; index >= 0; index--) {
          yield* edits.undo(projectId);
          // AC-5: each undo gives back the bytes before that change exactly.
          assert.strictEqual(readEdit(root), texts[index], `undo to step ${index}`);
        }
        assert.strictEqual(readEdit(root), texts[0]);
        for (let index = 1; index <= 10; index++) {
          yield* edits.redo(projectId);
          assert.strictEqual(readEdit(root), texts[index], `redo to step ${index}`);
        }
        assert.strictEqual(readEdit(root), texts[10]);
      }),
    ),
  );

  it.effect("keeps every file in assets/ untouched across 20 gestures and 20 undos", () =>
    withProject(({ projectId, root, edits }) =>
      Effect.gen(function* () {
        const clip = NodePath.join(root, "assets", "cam.mp4");
        NodeFS.mkdirSync(NodePath.dirname(clip), { recursive: true });
        NodeFS.writeFileSync(clip, Buffer.alloc(4096, 7));
        const before = NodeFS.statSync(clip);
        const initial = yield* edits.read(projectId);
        let snapshot = yield* edits.apply(projectId, cutOps(30), {
          origin: "agent",
          baseRevision: initial.revision,
        });
        for (let index = 0; index < 20; index++) {
          const ids = videoIds(snapshot);
          // Nudge the last item right by one frame per gesture: always a real change.
          const last = snapshot.document.tracks[0]!.items.at(-1)!;
          snapshot = yield* edits.apply(
            projectId,
            [{ _tag: "moveItem", itemId: ids.at(-1)!, start: last.start + 1 }],
            { origin: "timeline", baseRevision: snapshot.revision },
          );
        }
        for (let index = 0; index < 20; index++) yield* edits.undo(projectId);
        const after = NodeFS.statSync(clip);
        assert.strictEqual(after.ino, before.ino);
        assert.strictEqual(after.mtimeMs, before.mtimeMs);
        assert.strictEqual(after.size, before.size);
      }),
    ),
  );

  it.effect("refuses an undo past the first revision without changing anything", () =>
    withProject(({ projectId, root, edits }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(projectId);
        assert.isFalse(initial.canUndo);
        const before = readEdit(root);
        const error = yield* edits.undo(projectId).pipe(Effect.flip);
        assert.strictEqual(error._tag, "EditUnavailableError");
        assert.strictEqual(error.reason, "nothing-to-undo");
        assert.strictEqual(readEdit(root), before);
      }),
    ),
  );
});

// Confidence check 2 and AC-9, by hand: `S7VIDEO_EDIT_TIMING=1 vp test run src/edit/TimelineEditHistory.test.ts`.
// One gesture on a 1,000-item edit with its `.s7history/` step; it runs on the server, off the UI thread.
describe.skipIf(process.env.S7VIDEO_EDIT_TIMING !== "1")(
  "timeline gesture timing (S7V-034)",
  () => {
    it.live("applies a gesture with its history step on a 1,000-item edit", () =>
      withProject(({ projectId, edits }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(projectId);
          let snapshot = yield* edits.apply(projectId, cutOps(1000), {
            origin: "agent",
            baseRevision: initial.revision,
          });
          const times: number[] = [];
          for (let index = 0; index < 15; index++) {
            const last = snapshot.document.tracks[0]!.items.at(-1)!;
            const started = yield* Clock.currentTimeMillis;
            snapshot = yield* edits.apply(
              projectId,
              [{ _tag: "moveItem", itemId: last.id, start: last.start + 1 }],
              { origin: "timeline", baseRevision: snapshot.revision },
            );
            times.push((yield* Clock.currentTimeMillis) - started);
          }
          const sorted = times.toSorted((a, b) => a - b);
          yield* Effect.log(
            `S7V-034 apply+step on 1,000 items: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`,
          );
        }),
      ),
    );
  },
);
