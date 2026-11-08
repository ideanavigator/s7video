// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Writes the clip and its cached transcript, hashes the clip.
/**
 * S7V-075: "add captions" writes one transcript caption track in one change (one version, one
 * undo step), and every later change to the video track rebuilds it inside that same change.
 * The real edit and history services, with a small clip file and its cached transcript.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type EditCaptionTrack,
  type EditDocument,
  type EditOp,
  type ProjectId,
  RunId,
  ThreadId,
  type Transcript,
} from "@t3tools/contracts";
import { captionItemsFor, type CaptionTranscript } from "@t3tools/shared/captionWords";
import { convertFrame, wordEditOps } from "@t3tools/shared/editWordCuts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CaptionTrackService from "./CaptionTrackService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { historyLog, layerEditTest } from "./editHarness.testkit.ts";

const FPS = { num: 30, den: 1 };
const reply = { threadId: ThreadId.make("thread-captions"), runId: RunId.make("run-captions") };

/** Twelve words, three a second, with a pause after every third. */
const WORDS = Array.from({ length: 12 }, (_, index) => ({
  text: index % 3 === 2 ? `word${index}.` : `word${index}`,
  startFrame: index * 20 + Math.floor(index / 3) * 15,
  endFrame: index * 20 + Math.floor(index / 3) * 15 + 15,
}));

const clipBytes = (name: string) => Buffer.from(`not really a video: ${name}`);
const fingerprintOf = (bytes: Buffer) => ({
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
});

const mediaEntry = (id: string, hasAudio = true) => ({
  id,
  kind: "video" as const,
  path: `assets/${id}.mp4`,
  fingerprint: fingerprintOf(clipBytes(id)),
  probe: { durationFrames: 900, hasVideo: true, hasAudio, fps: FPS },
});

/** Writes the clip and, unless `transcribed` is false, its cached transcript. */
const writeClip = (root: string, id: string, transcribed = true) => {
  const bytes = clipBytes(id);
  NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "assets", `${id}.mp4`), bytes);
  if (!transcribed) return;
  const fingerprint = fingerprintOf(bytes);
  const transcript: Transcript = {
    transcriptVersion: 1,
    mediaFingerprint: fingerprint,
    model: "test",
    revision: "test",
    fps: FPS,
    durationFrames: 900,
    words: WORDS.map((word) => ({ ...word, confidence: 1, speaker: "S1" })),
    createdAt: "2026-11-09T00:00:00.000Z",
  };
  const dir = NodePath.join(root, ".s7cache", "transcripts");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, `${fingerprint.sha256}.json`),
    JSON.stringify(transcript),
  );
};

const transcripts: ReadonlyMap<string, CaptionTranscript> = new Map([
  ["cam", { fps: FPS, words: WORDS }],
]);

interface Project {
  readonly projectId: ProjectId;
  readonly root: string;
  readonly edits: EditDocumentService.EditDocumentService["Service"];
  readonly captions: CaptionTrackService.CaptionTrackService["Service"];
}

const withProject = <A, E>(body: (project: Project) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-captions-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const created = yield* folders.createNamedProject({ name: "Captions test" });
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        edits: yield* EditDocumentService.EditDocumentService,
        captions: yield* CaptionTrackService.CaptionTrackService,
      });
    }).pipe(
      Effect.provide(CaptionTrackService.layer.pipe(Layer.provideMerge(layerEditTest(baseDir)))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** The clip cut into three kept parts, as silence removal leaves it. */
const cutEdit = (media = [mediaEntry("cam")]): EditOp[] => [
  ...media.map((entry) => ({ _tag: "putMedia" as const, media: entry })),
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
  {
    _tag: "setKeepRanges",
    trackId: "V1",
    mediaId: "cam",
    ranges: [
      { in: 0, duration: 70 },
      { in: 85, duration: 90 },
      { in: 190, duration: 110 },
    ],
  },
];

const setUp = (project: Project, ops = cutEdit()) =>
  Effect.gen(function* () {
    const initial = yield* project.edits.read(project.projectId);
    return yield* project.edits.apply(project.projectId, ops, {
      origin: "agent",
      baseRevision: initial.revision,
    });
  });

const captionTracks = (document: EditDocument) =>
  document.tracks.filter((track): track is EditCaptionTrack => track.kind === "caption");

/** The track's captions without their ids, to compare with `captionItemsFor`. */
const captionsOf = (document: EditDocument) =>
  captionTracks(document)[0]!.items.map(({ id: _id, ...rest }) => rest);

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

describe("CaptionTrackService (S7V-075)", () => {
  it.effect("adds one caption track in one change, one version and one undo step", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        const before = yield* setUp(project);
        const textBefore = readEdit(project.root);
        const steps = historyLog(project.root)!.entries.length;
        const result = yield* project.captions.addCaptions(project.projectId, { reply });
        assert.deepStrictEqual(result, {
          revision: before.revision + 1,
          captions: 3,
          changed: true,
        });
        const after = yield* project.edits.read(project.projectId);
        const [track] = captionTracks(after.document);
        assert.deepStrictEqual(
          { id: track!.id, label: track!.label, metadata: track!.metadata },
          { id: "C1", label: "Captions", metadata: { s7: { source: "transcript" } } },
        );
        assert.deepStrictEqual(
          captionsOf(after.document),
          captionItemsFor(after.document, transcripts),
        );
        // The second run keeps source frames 85-175: the ends of word3 and word7 fall inside it.
        assert.strictEqual(captionsOf(after.document)[1]!.text, "word3 word4 word5. word6 word7");
        assert.strictEqual(historyLog(project.root)!.entries.length, steps + 1);
        const [newest] = yield* project.edits.versions(project.projectId);
        assert.deepStrictEqual(
          { author: newest!.author, changes: newest!.changes, runId: newest!.runId },
          { author: "assistant", changes: ["Added captions"], runId: reply.runId },
        );

        yield* project.edits.undo(project.projectId);
        assert.strictEqual(readEdit(project.root), textBefore);
        yield* project.edits.redo(project.projectId);
        const redone = yield* project.edits.read(project.projectId);
        assert.deepStrictEqual(redone.document, after.document);
      }),
    ),
  );

  it.effect("asking again rebuilds the same track, never a second one", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project);
        const first = yield* project.captions.addCaptions(project.projectId, {});
        const again = yield* project.captions.addCaptions(project.projectId, {});
        assert.deepStrictEqual(again, { revision: first.revision, captions: 3, changed: false });
        const after = yield* project.edits.read(project.projectId);
        assert.strictEqual(captionTracks(after.document).length, 1);
      }),
    ),
  );

  it.effect("refuses a clip with no transcript, and changes nothing", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam", false);
        const before = yield* setUp(project);
        const error = yield* project.captions.addCaptions(project.projectId, {}).pipe(Effect.flip);
        assert.strictEqual(error._tag, "CaptionsError");
        assert.include(error.message, "Transcribe the clip first");
        const after = yield* project.edits.read(project.projectId);
        assert.strictEqual(after.revision, before.revision);
        assert.strictEqual(captionTracks(after.document).length, 0);
      }),
    ),
  );

  it.effect("a clip without sound gets no captions; with only silent clips nothing is added", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam", false);
        const before = yield* setUp(project, cutEdit([mediaEntry("cam", false)]));
        const error = yield* project.captions.addCaptions(project.projectId, {}).pipe(Effect.flip);
        assert.strictEqual(error._tag === "CaptionsError" && error.reason, "no-clips");
        assert.strictEqual(
          (yield* project.edits.read(project.projectId)).revision,
          before.revision,
        );
      }),
    ),
  );

  it.effect("every change to the video track rebuilds the captions in the same change", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project);
        yield* project.captions.addCaptions(project.projectId, {});
        const words = WORDS.map((word) => ({
          start: convertFrame(word.startFrame, FPS, FPS, false),
          end: convertFrame(word.endFrame, FPS, FPS, true),
        }));
        const ids = (document: EditDocument) =>
          document.tracks.find((track) => track.kind === "video")!.items.map((item) => item.id);
        const changes: ReadonlyArray<{
          readonly name: string;
          readonly origin: "agent" | "timeline" | "transcript";
          readonly ops: (document: EditDocument) => ReadonlyArray<EditOp>;
        }> = [
          {
            name: "silence removal",
            origin: "agent",
            ops: () => [
              {
                _tag: "setKeepRanges",
                trackId: "V1",
                mediaId: "cam",
                ranges: [
                  { in: 0, duration: 60 },
                  { in: 95, duration: 70 },
                  { in: 200, duration: 100 },
                ],
              },
            ],
          },
          {
            name: "word cut",
            origin: "transcript",
            ops: (document) => {
              const edit = wordEditOps(document, "cam", words, { first: 4, last: 4 }, "cut");
              return edit._tag === "cut" ? edit.ops : [];
            },
          },
          {
            name: "word restore",
            origin: "transcript",
            ops: (document) => {
              const edit = wordEditOps(document, "cam", words, { first: 4, last: 4 }, "restore");
              return edit._tag === "restore" ? edit.ops : [];
            },
          },
          {
            name: "move",
            origin: "timeline",
            ops: (document) => [{ _tag: "moveItem", itemId: ids(document).at(-1)!, start: 400 }],
          },
          {
            name: "trim",
            origin: "timeline",
            ops: (document) => [
              { _tag: "trimItem", itemId: ids(document)[0]!, edge: "start", frame: 30 },
            ],
          },
          {
            name: "split",
            origin: "timeline",
            ops: (document) => [{ _tag: "splitItem", itemId: ids(document)[1]!, atFrame: 80 }],
          },
          {
            name: "delete",
            origin: "timeline",
            ops: (document) => [{ _tag: "deleteItem", itemIds: [ids(document)[0]!], ripple: true }],
          },
        ];
        const texts = [readEdit(project.root)];
        for (const change of changes) {
          const before = yield* project.edits.read(project.projectId);
          const steps = historyLog(project.root)!.entries.length;
          const ops = change.ops(before.document);
          assert.isAbove(ops.length, 0, change.name);
          const after = yield* project.edits.apply(project.projectId, ops, {
            origin: change.origin,
            baseRevision: before.revision,
          });
          assert.strictEqual(after.revision, before.revision + 1, change.name);
          assert.strictEqual(historyLog(project.root)!.entries.length, steps + 1, change.name);
          assert.deepStrictEqual(
            captionsOf(after.document),
            captionItemsFor(after.document, transcripts),
            change.name,
          );
          // The version line names the user's change, not the rebuild.
          const [newest] = yield* project.edits.versions(project.projectId);
          assert.notInclude(newest!.changes.join(";"), "caption", change.name);
          texts.push(readEdit(project.root));
        }
        // The word cut dropped "word4" from the captions; the restore brought it back.
        const textAfter = (index: number) => texts[index]!.includes('"word4"');
        assert.deepStrictEqual([textAfter(1), textAfter(2), textAfter(3)], [true, false, true]);
        // Undo puts each edit back together with its captions.
        for (let index = texts.length - 2; index >= 0; index--) {
          yield* project.edits.undo(project.projectId);
          assert.strictEqual(readEdit(project.root), texts[index], `undo to ${index}`);
        }
      }),
    ),
  );

  it.effect("cutting everything leaves an empty caption track", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        const snapshot = yield* setUp(project);
        yield* project.captions.addCaptions(project.projectId, {});
        const ids = snapshot.document.tracks.find((track) => track.kind === "video")!.items;
        const current = yield* project.edits.read(project.projectId);
        const after = yield* project.edits.apply(
          project.projectId,
          [{ _tag: "deleteItem", itemIds: ids.map((item) => item.id), ripple: true }],
          { origin: "timeline", baseRevision: current.revision },
        );
        assert.deepStrictEqual(captionTracks(after.document)[0]!.items, []);
      }),
    ),
  );

  it.effect("a caption track written by hand is never rebuilt", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        const snapshot = yield* setUp(project, [
          ...cutEdit(),
          { _tag: "addTrack", track: { kind: "caption", id: "C1", items: [] } },
          {
            _tag: "setCaptions",
            trackId: "C1",
            captions: [{ start: 0, duration: 15, text: "hi" }],
          },
        ]);
        const first = snapshot.document.tracks.find((track) => track.kind === "video")!.items[0]!;
        const after = yield* project.edits.apply(
          project.projectId,
          [{ _tag: "deleteItem", itemIds: [first.id], ripple: true }],
          { origin: "timeline", baseRevision: snapshot.revision },
        );
        assert.deepStrictEqual(captionsOf(after.document), [
          { start: 0, duration: 15, text: "hi" },
        ]);
      }),
    ),
  );
});
