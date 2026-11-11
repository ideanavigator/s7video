// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off -- Reads the cached clip and the references, prints the result for the ticket.
/**
 * Golden `silence-cut-after-move` (S7V-078), edit half: talking-head-01 split in three, the third
 * part moved first with a 30-frame gap, then cut. Each part loses exactly the unmoved cut's frames
 * where it sits. Export half: `silence_cut_after_move_golden.py`. `S7VIDEO_GOLDEN_UPDATE=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type EditDocument,
  type EditOp,
  SilenceLevels,
  Transcript,
  validateEditDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EngineService from "../engine/EngineService.ts";
import { toEditProbe } from "../media/MediaLibraryService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { layerEditTest } from "./editHarness.testkit.ts";
import * as EditProjectLayout from "./EditProjectLayout.ts";
import * as SilenceCutService from "./SilenceCutService.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const REFERENCES = NodePath.join(REPO, "packages/engine/tests/golden/references");
const SILENCE_CUT = NodePath.join(REFERENCES, "silence-cut-talking-head.json");
const REFERENCE = NodePath.join(REFERENCES, "silence-cut-after-move.json");
const TRANSCRIPT = NodePath.join(REPO, "fixtures/media/talking-head-01.transcript.json");
const CLIP = NodePath.join(
  process.env.S7VIDEO_TEST_MEDIA_DIR ??
    NodePath.join(NodeOS.homedir(), "Library/Caches/s7video-test-media"),
  "talking-head-01.webm",
);
const UPDATE = process.env.S7VIDEO_GOLDEN_UPDATE === "1";
const RATE = "30000/1001";
const FPS = { num: 30000, den: 1001 };
const GAP = 30;
const available =
  NodeFS.existsSync(CLIP) &&
  ["uv", "ffmpeg", "ffprobe"].every((name) =>
    ["/opt/homebrew/bin", "/usr/local/bin"].some((folder) =>
      NodeFS.existsSync(`${folder}/${name}`),
    ),
  );

type Span = readonly [number, number];
type Placed = readonly [start: number, duration: number, sourceIn: number];

const placed = (document: EditDocument): Placed[] =>
  document.tracks
    .find((track) => track.kind === "video")!
    .items.map((item) => [item.start, item.duration, "in" in item ? (item.in ?? 0) : 0]);

const decodeTranscript = Schema.decodeUnknownSync(Schema.fromJsonString(Transcript));
const decodeLevels = Schema.decodeUnknownSync(Schema.fromJsonString(SilenceLevels));

/** Each piece's frames that the unmoved cut keeps, laid end to end where the piece starts. */
function expectedItems(
  pieces: ReadonlyArray<{ readonly start: number; readonly span: Span }>,
  kept: ReadonlyArray<Span>,
): Placed[] {
  const items: Placed[] = [];
  let shift = 0;
  for (const { start, span } of pieces) {
    let at = start - shift;
    for (const [from, to] of kept) {
      const a = Math.max(from, span[0]);
      const b = Math.min(to, span[1]);
      if (b <= a) continue;
      items.push([at, b - a, a]);
      at += b - a;
    }
    // Later pieces close up by what this one lost; the gaps between pieces stay.
    shift += span[1] - span[0] - (at - (start - shift));
  }
  return items;
}

describe.skipIf(!available)("silence-cut-after-move golden", () => {
  it.live("cuts a rearranged clip in place, keeping the order and the gap", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-move-golden-" });
      const words = decodeTranscript(NodeFS.readFileSync(TRANSCRIPT, "utf8"));
      const cacheDir = NodePath.join(baseDir, "transcripts");
      const levelsFile = NodePath.join(cacheDir, `${words.mediaFingerprint.sha256}.levels.json`);
      const services = SilenceCutService.layer.pipe(
        Layer.provideMerge(
          Layer.mock(TranscriptService.TranscriptService)({
            levels: (input) =>
              Effect.sync(() => ({
                transcript: words,
                cached: NodeFS.existsSync(levelsFile)
                  ? decodeLevels(NodeFS.readFileSync(levelsFile, "utf8"))
                  : null,
                measure: {
                  projectId: input.projectId,
                  path: CLIP,
                  cacheDir,
                  fingerprint: words.mediaFingerprint,
                },
              })),
          }),
        ),
        Layer.provideMerge(EngineService.layer),
        Layer.provideMerge(layerEditTest(baseDir)),
      );
      const unmoved = (
        JSON.parse(NodeFS.readFileSync(SILENCE_CUT, "utf8")) as {
          rates: Record<string, { mediaFrames: number; ranges: Array<[number, number]> }>;
        }
      ).rates[RATE]!;

      return yield* Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const edits = yield* EditDocumentService.EditDocumentService;
        const engine = yield* EngineService.EngineService;
        const silences = yield* SilenceCutService.SilenceCutService;
        const created = yield* folders.createNamedProject({ name: "Move golden" });
        const editFile = NodePath.join(created.workspaceRoot, EditProjectLayout.EDIT_FILE);
        const read = () => NodeFS.readFileSync(editFile, "utf8");
        const probe = toEditProbe(yield* engine.probe({ path: CLIP }), FPS);
        const mediaFrames = probe.durationFrames!;
        expect(mediaFrames).toBe(unmoved.mediaFrames);
        const opened = yield* edits.read(created.projectId);
        NodeFS.writeFileSync(
          editFile,
          EditProjectLayout.editFileContents({ ...opened.document, fps: FPS }),
        );
        const start = yield* edits.read(created.projectId);
        const media = {
          id: "cam",
          kind: "video" as const,
          reference: CLIP,
          fingerprint: words.mediaFingerprint,
          probe,
        };
        yield* edits.apply(created.projectId, [{ _tag: "putMedia", media }], {
          origin: "import",
          baseRevision: start.revision,
        });
        const imported = yield* edits.read(created.projectId);
        yield* edits.apply(
          created.projectId,
          [
            { _tag: "addTrack", track: { kind: "video", id: "V1", role: "main", items: [] } },
            {
              _tag: "setKeepRanges",
              trackId: "V1",
              mediaId: "cam",
              ranges: [{ in: 0, duration: mediaFrames }],
            },
          ],
          { origin: "agent", baseRevision: imported.revision },
        );

        // Split into three on the timeline, then drag the third part first with a gap after it.
        const first = Math.floor(mediaFrames / 3);
        const second = Math.floor((2 * mediaFrames) / 3);
        const third = mediaFrames - second;
        const gestures: ReadonlyArray<EditOp[]> = [
          [{ _tag: "splitItem", itemId: "v1", atFrame: first, newItemId: "v2" }],
          [{ _tag: "splitItem", itemId: "v2", atFrame: second, newItemId: "v3" }],
          [
            { _tag: "moveItem", itemId: "v2", start: third + GAP + first },
            { _tag: "moveItem", itemId: "v1", start: third + GAP },
            { _tag: "moveItem", itemId: "v3", start: 0 },
          ],
        ];
        for (const ops of gestures) {
          const before = yield* edits.read(created.projectId);
          yield* edits.apply(created.projectId, ops, {
            origin: "timeline",
            baseRevision: before.revision,
          });
        }
        const moved = yield* edits.read(created.projectId);
        const movedBytes = read();
        const pieces = [
          { start: 0, span: [second, mediaFrames] as Span },
          { start: third + GAP, span: [0, first] as Span },
          { start: third + GAP + first, span: [first, second] as Span },
        ];
        expect(placed(moved.document)).toEqual(
          pieces.map(({ start: at, span }) => [at, span[1] - span[0], span[0]]),
        );
        const versionsBefore = yield* edits.versions(created.projectId);

        const result = yield* silences.removeSilences({ projectId: created.projectId });
        const cut = yield* edits.read(created.projectId);
        const items = placed(cut.document);
        expect(validateEditDocument(cut.document).ok).toBe(true);

        // AC-1: each piece loses exactly the frames the unmoved cut removes, where it sits.
        expect(items).toEqual(expectedItems(pieces, unmoved.ranges));
        const ids = cut.document.tracks[0]!.items.map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        // v3 and v2 start in speech, so their first parts keep their ids.
        expect(ids[0]).toBe("v3");
        expect(ids).toContain("v2");
        // AC-3: one change, one version; one undo gives the moved edit back byte for byte.
        expect(cut.revision).toBe(moved.revision + 1);
        expect((yield* edits.versions(created.projectId)).length).toBe(versionsBefore.length + 1);
        const cutBytes = read();
        const again = yield* silences.removeSilences({ projectId: created.projectId });
        expect(again.changed).toBe(false);
        expect(read()).toBe(cutBytes);
        yield* edits.undo(created.projectId);
        expect(read()).toBe(movedBytes);
        yield* edits.redo(created.projectId);
        expect(read()).toBe(cutBytes);

        const keptFrames = items.reduce((sum, [, duration]) => sum + duration, 0);
        const observed = {
          clip: "talking-head-01",
          rate: RATE,
          mediaFrames,
          gap: GAP,
          pieces: pieces.map(({ start: at, span }) => [at, span[0], span[1]]),
          cuts: result.cuts,
          removedFrames: mediaFrames - keptFrames,
          durationFrames: Math.max(...items.map(([at, duration]) => at + duration)),
          items,
        };
        console.log(
          `silence-cut-after-move: ${result.cuts} cuts, ${observed.removedFrames} frames removed, ${items.length} clips in the user's order, gap kept, undo byte exact`,
        );
        if (UPDATE) NodeFS.writeFileSync(REFERENCE, `${JSON.stringify(observed, null, 1)}\n`);
        expect(observed).toEqual(JSON.parse(NodeFS.readFileSync(REFERENCE, "utf8")));
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
