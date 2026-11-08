// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off -- Reads the transcript fixture and the reference, prints the result for the ticket.
/**
 * Golden `text-edit-cut` (S7V-038), edit half: talking-head-01 cut by deleting 5 word selections in
 * its transcript, then restoring 2, through the edit service with origin `transcript`. Cut list exact
 * vs the reference; each restore gives back the cut list from before its delete. The export half
 * is `text_edit_cut_golden.py`. `S7VIDEO_GOLDEN_UPDATE=1` rewrites the reference.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type EditDocument, Transcript } from "@t3tools/contracts";
import { convertFrame, keptSpansOf, wordEditOps } from "@t3tools/shared/editWordCuts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { layerEditTest } from "./editHarness.testkit.ts";
import * as EditProjectLayout from "./EditProjectLayout.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const TRANSCRIPT = NodePath.join(REPO, "fixtures/media/talking-head-01.transcript.json");
const REFERENCE = NodePath.join(REPO, "packages/engine/tests/golden/references/text-edit-cut.json");
const UPDATE = process.env.S7VIDEO_GOLDEN_UPDATE === "1";
const RATE = "30000/1001";
const FPS = { num: 30000, den: 1001 };
/** talking-head-01's length at 29.97 fps, as the silence-cut golden probes it. */
const MEDIA_FRAMES = 4195;

/** Word selections (first, last), deleted in order; then the last two restored, newest first. */
const DELETES: ReadonlyArray<readonly [number, number]> = [
  [3, 5],
  [20, 20],
  [41, 44],
  [86, 87],
  [120, 126],
];
const RESTORES = [4, 3];

type Placed = readonly [start: number, duration: number, sourceIn: number];

const placed = (document: EditDocument): Placed[] =>
  document.tracks
    .find((track) => track.kind === "video")!
    .items.map((item) => [item.start, item.duration, "in" in item ? (item.in ?? 0) : 0]);

const transcript = Schema.decodeSync(Schema.fromJsonString(Transcript))(
  NodeFS.readFileSync(TRANSCRIPT, "utf8"),
);
/** The words at the document's rate, as the Transcript tab shows them (start down, end up). */
const words = transcript.words.map((word) => ({
  start: convertFrame(word.startFrame, transcript.fps, FPS, false),
  end: convertFrame(word.endFrame, transcript.fps, FPS, true),
}));

describe("text-edit-cut golden", () => {
  it.live("cuts and restores words through the edit service, frame exact", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-text-golden-" });
      return yield* Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const edits = yield* EditDocumentService.EditDocumentService;
        const created = yield* folders.createNamedProject({ name: "Text golden" });
        const editFile = NodePath.join(created.workspaceRoot, EditProjectLayout.EDIT_FILE);
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
                // Never read here: the export half renders the cached clip.
                reference: "/test-media/talking-head-01.webm",
                fingerprint: transcript.mediaFingerprint,
                probe: { durationFrames: MEDIA_FRAMES, hasVideo: true, hasAudio: true },
              },
            },
            { _tag: "addTrack", track: { kind: "video", id: "V1", role: "main", items: [] } },
            {
              _tag: "setKeepRanges",
              trackId: "V1",
              mediaId: "cam",
              ranges: [{ in: 0, duration: MEDIA_FRAMES }],
            },
          ],
          { origin: "agent", baseRevision: start.revision },
        );

        const textEdit = (selection: readonly [number, number], action: "cut" | "restore") =>
          Effect.gen(function* () {
            const edit = wordEditOps(
              snapshot.document,
              "cam",
              words,
              { first: selection[0], last: selection[1] },
              action,
            );
            expect(edit._tag).toBe(action);
            const before = snapshot.revision;
            snapshot = yield* edits.apply(
              created.projectId,
              edit._tag === "cut" || edit._tag === "restore" ? edit.ops : [],
              {
                origin: "transcript",
                baseRevision: before,
              },
            );
            // One text edit, one revision and one version.
            expect(snapshot.revision).toBe(before + 1);
            expect(snapshot.document).toEqual(JSON.parse(NodeFS.readFileSync(editFile, "utf8")));
            return edit;
          });

        const history: Placed[][] = [placed(snapshot.document)];
        const cuts: Array<readonly [number, number]> = [];
        for (const selection of DELETES) {
          const kept = keptSpansOf(snapshot.document, "cam");
          const edit = yield* textEdit(selection, "cut");
          if (edit._tag !== "cut") continue;
          cuts.push(edit.cut.range);
          // AC-4: the items (what the timeline draws and the player plays) lose exactly the cut.
          const [from, to] = edit.cut.range;
          const expected = kept.flatMap(([a, b]) =>
            [
              [a, Math.min(b, from)],
              [Math.max(a, to), b],
            ].filter(([x, y]) => y! > x!),
          );
          expect(keptSpansOf(snapshot.document, "cam")).toEqual(expected);
          history.push(placed(snapshot.document));
        }
        const cutItems = placed(snapshot.document);
        for (const index of RESTORES) {
          yield* textEdit(DELETES[index]!, "restore");
          // AC-2: the cut list from before that delete, exactly.
          expect(placed(snapshot.document)).toEqual(history[index]);
        }
        const versions = yield* edits.versions(created.projectId);
        expect(versions.slice(0, DELETES.length + RESTORES.length).map((v) => v.changes)).toEqual([
          ...RESTORES.map(() => ["Put back words in the transcript"]),
          ...DELETES.map(() => ["Cut words in the transcript"]),
        ]);
        for (const [startFrame, duration, sourceIn] of placed(snapshot.document)) {
          for (const frame of [startFrame, duration, sourceIn]) {
            expect(Number.isInteger(frame)).toBe(true);
          }
        }

        const items = placed(snapshot.document);
        const observed = {
          clip: "talking-head-01",
          rate: RATE,
          mediaFrames: MEDIA_FRAMES,
          deletes: DELETES,
          restores: RESTORES,
          cuts,
          cutItems,
          durationFrames: items.reduce((sum, [, duration]) => sum + duration, 0),
          items,
        };
        console.log(
          `text-edit-cut: ${DELETES.length} cuts, ${RESTORES.length} restores, ${items.length} clips, ${observed.durationFrames} frames, cut list exact`,
        );
        if (UPDATE) NodeFS.writeFileSync(REFERENCE, `${JSON.stringify(observed, null, 1)}\n`);
        expect(observed).toEqual(JSON.parse(NodeFS.readFileSync(REFERENCE, "utf8")));
      }).pipe(Effect.provide(layerEditTest(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
