// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off -- Reads the cached clip and the references, prints the result for the ticket.
/**
 * Golden `timeline-edit-roundtrip` (S7V-034), edit half: the silence-cut talking-head-01 edited by
 * timeline gestures; cut list vs the reference, undo/redo byte exact. The export half is
 * `timeline_edit_roundtrip_golden.py`. `S7VIDEO_GOLDEN_UPDATE=1` rewrites the reference.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type EditDocument, type EditOp, validateEditDocument } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { layerEditTest } from "./editHarness.testkit.ts";
import * as EditProjectLayout from "./EditProjectLayout.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const REFERENCES = NodePath.join(REPO, "packages/engine/tests/golden/references");
const SILENCE_CUT = NodePath.join(REFERENCES, "silence-cut-talking-head.json");
const REFERENCE = NodePath.join(REFERENCES, "timeline-edit-roundtrip.json");
const CLIP = NodePath.join(
  process.env.S7VIDEO_TEST_MEDIA_DIR ??
    NodePath.join(NodeOS.homedir(), "Library/Caches/s7video-test-media"),
  "talking-head-01.webm",
);
const UPDATE = process.env.S7VIDEO_GOLDEN_UPDATE === "1";
const RATE = "30000/1001";
const FPS = { num: 30000, den: 1001 };

type Placed = readonly [start: number, duration: number, sourceIn: number];

const videoItems = (document: EditDocument) =>
  document.tracks
    .find((track) => track.kind === "video")!
    .items.map((item) => ({
      id: item.id,
      start: item.start,
      duration: item.duration,
      in: "in" in item ? (item.in ?? 0) : 0,
    }));

const placed = (document: EditDocument): Placed[] =>
  videoItems(document).map((item) => [item.start, item.duration, item.in]);

/** The gestures, each planned from the edit as it stands, as the timeline sends them. */
const gestures: ReadonlyArray<(document: EditDocument) => EditOp[]> = [
  // Move the last clip right, leaving a 30-frame gap before it.
  (document) => {
    const last = videoItems(document).at(-1)!;
    return [{ _tag: "moveItem", itemId: last.id, start: last.start + 30 }];
  },
  // Trim 10 frames off the first clip's end, and 8 off the second clip's start.
  (document) => {
    const first = videoItems(document)[0]!;
    return [
      { _tag: "trimItem", itemId: first.id, edge: "end", frame: first.start + first.duration - 10 },
    ];
  },
  (document) => {
    const second = videoItems(document)[1]!;
    return [{ _tag: "trimItem", itemId: second.id, edge: "start", frame: second.start + 8 }];
  },
  // Split the third clip in the middle.
  (document) => {
    const third = videoItems(document)[2]!;
    return [
      {
        _tag: "splitItem",
        itemId: third.id,
        atFrame: third.start + Math.floor(third.duration / 2),
        newItemId: "split-right",
      },
    ];
  },
  // Delete the fifth clip, leaving a gap; ripple delete the sixth.
  (document) => [{ _tag: "deleteItem", itemIds: [videoItems(document)[4]!.id], ripple: false }],
  (document) => [{ _tag: "deleteItem", itemIds: [videoItems(document)[5]!.id], ripple: true }],
  // Move the split's right half after the last clip: an earlier part of the source plays later.
  (document) => {
    const end = Math.max(...videoItems(document).map((item) => item.start + item.duration));
    return [{ _tag: "moveItem", itemId: "split-right", start: end + 15 }];
  },
];

const available = NodeFS.existsSync(CLIP) && NodeFS.existsSync(SILENCE_CUT);

describe.skipIf(!available)("timeline-edit-roundtrip golden", () => {
  it.live("edits the silence-cut clip by hand, then undoes and redoes it exactly", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-timeline-golden-" });
      const cut = (
        JSON.parse(NodeFS.readFileSync(SILENCE_CUT, "utf8")) as {
          rates: Record<string, { mediaFrames: number; ranges: Array<[number, number]> }>;
        }
      ).rates[RATE]!;
      return yield* Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const edits = yield* EditDocumentService.EditDocumentService;
        const created = yield* folders.createNamedProject({ name: "Timeline golden" });
        const editFile = NodePath.join(created.workspaceRoot, EditProjectLayout.EDIT_FILE);
        const read = () => NodeFS.readFileSync(editFile, "utf8");
        const opened = yield* edits.read(created.projectId);
        NodeFS.writeFileSync(
          editFile,
          EditProjectLayout.editFileContents({ ...opened.document, fps: FPS }),
        );
        const start = yield* edits.read(created.projectId);
        let snapshot = yield* edits.apply(
          created.projectId,
          [
            {
              _tag: "putMedia",
              media: {
                id: "cam",
                kind: "video",
                reference: CLIP,
                fingerprint: { sha256: "0".repeat(64), size: NodeFS.statSync(CLIP).size },
                probe: { durationFrames: cut.mediaFrames, hasVideo: true, hasAudio: true },
              },
            },
            { _tag: "addTrack", track: { kind: "video", id: "V1", role: "main", items: [] } },
            {
              _tag: "setKeepRanges",
              trackId: "V1",
              mediaId: "cam",
              ranges: cut.ranges.map(([from, to]) => ({ in: from, duration: to - from })),
            },
          ],
          { origin: "agent", baseRevision: start.revision },
        );
        const cutBytes = read();
        expect(
          placed(snapshot.document).map(([, duration, from]) => [from, from + duration]),
        ).toEqual(cut.ranges);

        for (const gesture of gestures) {
          const before = snapshot.revision;
          snapshot = yield* edits.apply(created.projectId, gesture(snapshot.document), {
            origin: "timeline",
            baseRevision: before,
          });
          // One gesture, one revision; the file on disk is what the service returned (AC-2).
          expect(snapshot.revision).toBe(before + 1);
          const onDisk = JSON.parse(read()) as EditDocument;
          expect(placed(onDisk)).toEqual(placed(snapshot.document));
        }
        expect(validateEditDocument(snapshot.document).ok).toBe(true);
        const editedBytes = read();
        const items = placed(snapshot.document);
        const durationFrames = Math.max(...items.map(([at, duration]) => at + duration));

        // AC-5: 7 undos give back the cut edit byte for byte; 7 redos the edited one.
        for (let index = 0; index < gestures.length; index++) yield* edits.undo(created.projectId);
        expect(read()).toBe(cutBytes);
        for (let index = 0; index < gestures.length; index++) yield* edits.redo(created.projectId);
        expect(read()).toBe(editedBytes);

        const observed = {
          clip: "talking-head-01",
          rate: RATE,
          mediaFrames: cut.mediaFrames,
          cutFrames: cut.ranges.reduce((sum, [from, to]) => sum + to - from, 0),
          durationFrames,
          items,
        };
        console.log(
          `timeline-edit-roundtrip: ${items.length} clips, ${durationFrames} frames (cut ${observed.cutFrames}), undo and redo byte exact`,
        );
        if (UPDATE) NodeFS.writeFileSync(REFERENCE, `${JSON.stringify(observed, null, 1)}\n`);
        expect(observed).toEqual(JSON.parse(NodeFS.readFileSync(REFERENCE, "utf8")));
      }).pipe(Effect.provide(layerEditTest(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
