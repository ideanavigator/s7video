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
import {
  captionItemsFor,
  captionMediaOfItem,
  type CaptionTranscript,
} from "@t3tools/shared/captionWords";
import { convertFrame, wordEditOps } from "@t3tools/shared/editWordCuts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as CaptionStillsService from "../export/CaptionStillsService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CaptionTrackService from "./CaptionTrackService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { historyLog, layerEditTest } from "./editHarness.testkit.ts";
import { ASSEMBLE_FIRST } from "./videoTrack.ts";
import { zoomOps } from "./zoomOps.ts";

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

/**
 * Writes the clip and, unless `transcribed` is false, its cached transcript; `burnedIn` is the
 * transcript's check for captions in the picture (S7V-099), none when missing.
 */
const writeClip = (root: string, id: string, transcribed = true, burnedIn?: boolean) => {
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
    ...(burnedIn === undefined
      ? {}
      : {
          burnedInCaptions: burnedIn
            ? { found: true, confidence: 0.9, region: { y0: 0.7, y1: 0.8 } }
            : { found: false, confidence: 0 },
        }),
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

/** The looks' previews, as `CaptionStillsService` finds them drawn (S7V-099). */
const PREVIEWS = [
  { id: "s7-neutral", name: "Plain", path: "/p/plain.png" },
  { id: "s7-box", name: "Boxed", path: "/p/boxed.png" },
  { id: "s7-karaoke", name: "Highlighted word", path: "/p/lit.png" },
  { id: "s7-minimal", name: "Minimal", path: null },
] as const;
const stillsLayer = Layer.mock(CaptionStillsService.CaptionStillsService)({
  previews: () => Effect.succeed(PREVIEWS),
});

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
      Effect.provide(
        CaptionTrackService.layer.pipe(
          Layer.provide(stillsLayer),
          Layer.provideMerge(layerEditTest(baseDir)),
        ),
      ),
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
          captioned: [],
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
        assert.deepStrictEqual(again, {
          revision: first.revision,
          captions: 3,
          changed: false,
          captioned: [],
        });
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
        assert.include(error.message, "no clip with sound is on the timeline");
        assert.strictEqual(
          (yield* project.edits.read(project.projectId)).revision,
          before.revision,
        );
      }),
    ),
  );

  // S7V-093: the Editor can't put a clip on an empty timeline, so the agent is told to do it.
  it.effect("on an empty timeline, says to place the clip with video_assemble first", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project, [{ _tag: "putMedia", media: mediaEntry("cam") }]);
        const error = yield* project.captions.addCaptions(project.projectId, {}).pipe(Effect.flip);
        assert.strictEqual(error._tag === "CaptionsError" && error.reason, "no-clips");
        assert.include(error.message, ASSEMBLE_FIRST);
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

  it.effect("a cut while a transcript can't be read keeps that clip's captions", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project);
        yield* project.captions.addCaptions(project.projectId, {});
        const before = yield* project.edits.read(project.projectId);
        const items = captionsOf(before.document);
        assert.deepStrictEqual(items[0]!.metadata, { s7: { media: "cam" } });
        // The cache is cleared (or the clip's drive unplugged): no transcript can be read.
        NodeFS.rmSync(NodePath.join(project.root, ".s7cache", "transcripts"), {
          recursive: true,
        });
        const first = before.document.tracks.find((track) => track.kind === "video")!.items[0]!;
        const after = yield* project.edits.apply(
          project.projectId,
          [{ _tag: "trimItem", itemId: first.id, edge: "end", frame: 60 }],
          { origin: "timeline", baseRevision: before.revision },
        );
        assert.strictEqual(after.revision, before.revision + 1);
        assert.deepStrictEqual(captionsOf(after.document), items);
      }),
    ),
  );

  it.effect("a ripple cut on an unreadable first clip moves the next clip's captions validly", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "b");
        writeClip(project.root, "cam");
        const initial = yield* project.edits.read(project.projectId);
        yield* project.edits.apply(
          project.projectId,
          [
            { _tag: "putMedia", media: mediaEntry("b") },
            { _tag: "putMedia", media: mediaEntry("cam") },
            {
              _tag: "addTrack",
              track: {
                kind: "video",
                id: "V1",
                items: [
                  { id: "v1", media: "b", start: 0, duration: 240, in: 0 },
                  { id: "v2", media: "cam", start: 240, duration: 240, in: 0 },
                ],
              },
            },
          ],
          { origin: "agent", baseRevision: initial.revision },
        );
        yield* project.captions.addCaptions(project.projectId, {});
        // b's transcript can no longer be read.
        NodeFS.rmSync(
          NodePath.join(
            project.root,
            ".s7cache",
            "transcripts",
            `${fingerprintOf(clipBytes("b")).sha256}.json`,
          ),
        );
        const before = yield* project.edits.read(project.projectId);
        const after = yield* project.edits.apply(
          project.projectId,
          [
            { _tag: "trimItem", itemId: "v1", edge: "end", frame: 120 },
            { _tag: "moveItem", itemId: "v2", start: 120 },
          ],
          { origin: "timeline", baseRevision: before.revision },
        );
        assert.strictEqual(after.revision, before.revision + 1);
        const items = captionsOf(after.document);
        const media = (item: (typeof items)[number]) =>
          (item.metadata as { s7: { media: string } }).s7.media;
        // b keeps the captions of what still plays of it; cam's follow cam to frame 120.
        const kept = items.filter((item) => media(item) === "b");
        assert.isAbove(kept.length, 0);
        assert.isTrue(kept.every((item) => item.start + item.duration <= 120));
        const moved = items.filter((item) => media(item) === "cam");
        assert.strictEqual(moved[0]!.start, 120);
        assert.deepStrictEqual(
          moved,
          captionItemsFor(after.document, transcripts).filter((item) => item.start >= 120),
        );
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

// S7V-037: a caption look is on the caption track; with no captions, picking one adds them.
describe("CaptionTrackService.setStyle (S7V-037)", () => {
  it.effect("with no captions, adds them in the look: one change, one version, one undo", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        const before = yield* setUp(project);
        const textBefore = readEdit(project.root);
        const steps = historyLog(project.root)!.entries.length;
        const result = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-box" },
          {
            origin: "timeline",
          },
        );
        assert.deepStrictEqual(result, {
          revision: before.revision + 1,
          captions: 3,
          changed: true,
          added: true,
          preset: "s7-box",
          custom: {},
          described: "",
          uncaptioned: [],
          captioned: [],
        });
        const after = yield* project.edits.read(project.projectId);
        const [track] = captionTracks(after.document);
        assert.deepStrictEqual(
          { style: track!.style, metadata: track!.metadata },
          { style: "s7-box", metadata: { s7: { source: "transcript" } } },
        );
        assert.deepStrictEqual(
          captionsOf(after.document),
          captionItemsFor(after.document, transcripts),
        );
        assert.strictEqual(historyLog(project.root)!.entries.length, steps + 1);
        const [newest] = yield* project.edits.versions(project.projectId);
        assert.deepStrictEqual(
          { author: newest!.author, changes: newest!.changes },
          { author: "you", changes: ["Added captions in the Boxed look"] },
        );

        // "Add captions" later rebuilds that same track: one track, and the look stays.
        yield* project.captions.addCaptions(project.projectId, {});
        const again = yield* project.edits.read(project.projectId);
        assert.strictEqual(captionTracks(again.document).length, 1);
        assert.strictEqual(captionTracks(again.document)[0]!.style, "s7-box");

        yield* project.edits.undo(project.projectId);
        assert.strictEqual(readEdit(project.root), textBefore);
      }),
    ),
  );

  it.effect("on captioned edits, changes only the look; the same look changes nothing", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project);
        const added = yield* project.captions.addCaptions(project.projectId, {});
        const items = captionsOf((yield* project.edits.read(project.projectId)).document);
        // No look on the track is the plain one.
        const plain = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-neutral" },
          {
            origin: "agent",
          },
        );
        assert.deepStrictEqual(plain, {
          revision: added.revision,
          captions: 3,
          changed: false,
          added: false,
          preset: "s7-neutral",
          custom: {},
          described: "",
          uncaptioned: [],
          captioned: [],
        });
        const karaoke = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-karaoke" },
          {
            origin: "agent",
            reply,
          },
        );
        assert.deepStrictEqual(karaoke, {
          revision: added.revision + 1,
          captions: 3,
          changed: true,
          added: false,
          preset: "s7-karaoke",
          custom: {},
          described: "",
          uncaptioned: [],
          captioned: [],
        });
        const after = yield* project.edits.read(project.projectId);
        assert.strictEqual(captionTracks(after.document)[0]!.style, "s7-karaoke");
        assert.deepStrictEqual(captionsOf(after.document), items);
        const [newest] = yield* project.edits.versions(project.projectId);
        assert.deepStrictEqual(newest!.changes, ["Changed the caption look to Highlighted word"]);
        yield* project.edits.undo(project.projectId);
        const undone = yield* project.edits.read(project.projectId);
        assert.isUndefined(captionTracks(undone.document)[0]!.style);
      }),
    ),
  );

  it.effect("a later cut and a zoom's splits keep the look and the captions", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project);
        yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-minimal" },
          { origin: "agent" },
        );
        const styled = yield* project.edits.read(project.projectId);
        const captions = captionTracks(styled.document)[0]!.items;
        // A zoom's splits continue the source: the rebuild finds nothing to change.
        const [first] = styled.document.tracks.find((track) => track.kind === "video")!.items;
        const zoom = { scale: 1.5, anchorX: 0.5, anchorY: 0.3, rampFrames: 0 };
        const zoomed = yield* project.edits.apply(
          project.projectId,
          zoomOps(styled.document, [{ start: first!.start + 10, end: first!.start + 30 }], zoom)
            .ops,
          { origin: "agent", baseRevision: styled.revision },
        );
        assert.deepStrictEqual(captionTracks(zoomed.document)[0]!.items, captions);
        assert.strictEqual(captionTracks(zoomed.document)[0]!.style, "s7-minimal");
        // A cut rebuilds the items; the track keeps its look.
        const video = zoomed.document.tracks.find((track) => track.kind === "video")!;
        const last = [...video.items].sort((a, b) => b.start - a.start)[0]!;
        const cut = yield* project.edits.apply(
          project.projectId,
          [{ _tag: "deleteItem", itemIds: [last.id], ripple: true }],
          { origin: "timeline", baseRevision: zoomed.revision },
        );
        assert.strictEqual(captionTracks(cut.document)[0]!.style, "s7-minimal");
        assert.isBelow(captionTracks(cut.document)[0]!.items.length, captions.length);
      }),
    ),
  );

  it.effect(
    "refuses a clip with no transcript when it would add captions, and changes nothing",
    () =>
      withProject((project) =>
        Effect.gen(function* () {
          writeClip(project.root, "cam", false);
          const before = yield* setUp(project);
          const error = yield* project.captions
            .setStyle(project.projectId, { preset: "s7-box" }, { origin: "timeline" })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "CaptionsError");
          assert.include(error.message, "then pick the look again");
          const after = yield* project.edits.read(project.projectId);
          assert.strictEqual(after.revision, before.revision);
          assert.strictEqual(captionTracks(after.document).length, 0);
        }),
      ),
  );
});

// S7V-099: captions in the user's words, and never over captions the picture already has unasked.
describe("CaptionTrackService in the chat (S7V-099)", () => {
  it.effect("refuses to add captions over a clip's own until confirmed; changes nothing", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam", true, true);
        const before = yield* setUp(project);
        const text = readEdit(project.root);
        const steps = historyLog(project.root)!.entries.length;
        for (const refused of [
          yield* project.captions.addCaptions(project.projectId, {}).pipe(Effect.flip),
          yield* project.captions
            .setStyle(project.projectId, { preset: "s7-box" }, { origin: "agent" })
            .pipe(Effect.flip),
          yield* project.captions.looks(project.projectId, {}).pipe(Effect.flip),
        ]) {
          assert.strictEqual(refused._tag, "CaptionsError");
          // The way forward for each answer (UX guide rule 9): the other place, anyway, or not.
          assert.include(
            refused.message,
            "cam.mp4 already has captions near the bottom. Add ours at the top, add them anyway, or leave it as it is?",
          );
          assert.include(refused.message, 'custom {"position": "top"}');
          assert.include(refused.message, "confirm: true");
        }
        // Asked for at the top already: the question doesn't offer the top again.
        const atTop = yield* project.captions
          .setStyle(project.projectId, { custom: { position: "top" } }, { origin: "agent" })
          .pipe(Effect.flip);
        assert.include(
          atTop.message,
          "cam.mp4 already has captions near the bottom; ours would be at the top. Add them, or leave it as it is?",
        );
        assert.notInclude(atTop.message, "Add ours at the top");
        assert.strictEqual(readEdit(project.root), text);
        assert.strictEqual(historyLog(project.root)!.entries.length, steps);

        // A yes given at the looks travels with the look the user then picks, once.
        const atLooks = yield* project.captions.looks(project.projectId, {}).pipe(Effect.flip);
        assert.include(
          atLooks.message,
          "ask for the looks again with confirm: true, and pass confirm: true with the look they pick",
        );
        const looks = yield* project.captions.looks(project.projectId, { confirm: true });
        assert.deepStrictEqual(looks, {
          revision: before.revision,
          looks: PREVIEWS,
          uncaptioned: [],
        });
        const added = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-box" },
          { origin: "agent", confirm: true },
        );
        assert.deepInclude(added, { added: true, changed: true, captions: 3 });
        // Captions the user already has: restyling or rebuilding them asks nothing.
        const restyled = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-minimal" },
          { origin: "agent" },
        );
        assert.isTrue(restyled.changed);
        assert.isFalse((yield* project.captions.addCaptions(project.projectId, {})).changed);
      }),
    ),
  );

  it.effect("a clip checked with none, or never checked, adds captions as before", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam", true, false);
        yield* setUp(project);
        assert.isTrue((yield* project.captions.addCaptions(project.projectId, {})).changed);
      }),
    ),
  );

  it.effect("the looks change nothing and still ask for a transcript first", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam", false);
        const before = yield* setUp(project);
        const refused = yield* project.captions.looks(project.projectId, {}).pipe(Effect.flip);
        assert.include(refused.message, "Transcribe the clip first");
        assert.include(refused.message, "ask for the looks again");
        writeClip(project.root, "cam");
        const looks = yield* project.captions.looks(project.projectId, {});
        assert.deepStrictEqual(looks, {
          revision: before.revision,
          looks: PREVIEWS,
          uncaptioned: [],
        });
        assert.strictEqual(
          (yield* project.edits.read(project.projectId)).revision,
          before.revision,
        );
      }),
    ),
  );

  it.effect(
    "colours, size and place are stored with the look, each change one version and one undo",
    () =>
      withProject((project) =>
        Effect.gen(function* () {
          writeClip(project.root, "cam");
          yield* setUp(project);
          const boxed = yield* project.captions.setStyle(
            project.projectId,
            { preset: "s7-box", custom: { textColor: "#FF8800", position: "top" } },
            { origin: "agent", reply },
          );
          assert.deepInclude(boxed, {
            added: true,
            preset: "s7-box",
            custom: { textColor: "#FF8800", position: "top" },
          });
          const first = yield* project.edits.read(project.projectId);
          assert.deepInclude(captionTracks(first.document)[0]!, {
            style: "s7-box",
            custom: { textColor: "#FF8800", position: "top" },
          });
          const steps = historyLog(project.root)!.entries.length;
          // "Make them a bit bigger": the look and the other changes stay.
          const bigger = yield* project.captions.setStyle(
            project.projectId,
            { custom: { size: 1.2 } },
            { origin: "agent", reply: { ...reply, runId: RunId.make("run-bigger") } },
          );
          assert.deepInclude(bigger, {
            changed: true,
            added: false,
            preset: "s7-box",
            custom: { textColor: "#FF8800", position: "top", size: 1.2 },
          });
          assert.strictEqual(historyLog(project.root)!.entries.length, steps + 1);
          const [newest] = yield* project.edits.versions(project.projectId);
          assert.deepStrictEqual(newest!.changes, [
            "Changed the caption look to Boxed (orange, at the top, a bit bigger)",
          ]);
          const same = yield* project.captions.setStyle(
            project.projectId,
            { custom: { size: 1.2 } },
            { origin: "agent" },
          );
          assert.isFalse(same.changed);
          // A size asked for now is said against the size before: 1.2 to 1.6, 1.4, then its own.
          const larger = yield* project.captions.setStyle(
            project.projectId,
            { custom: { size: 1.6 } },
            { origin: "agent" },
          );
          assert.strictEqual(larger.described, "orange, at the top, bigger");
          const smaller = yield* project.captions.setStyle(
            project.projectId,
            { custom: { size: 1.4 } },
            { origin: "agent" },
          );
          assert.strictEqual(smaller.described, "orange, at the top, a bit smaller");
          const own = yield* project.captions.setStyle(
            project.projectId,
            { custom: { size: 1 } },
            { origin: "agent" },
          );
          assert.strictEqual(own.described, "orange, at the top, back to its own size");
          yield* project.edits.undo(project.projectId);
          yield* project.edits.undo(project.projectId);
          yield* project.edits.undo(project.projectId);
          // Undo takes back only the size.
          yield* project.edits.undo(project.projectId);
          const undone = yield* project.edits.read(project.projectId);
          assert.deepStrictEqual(undone.document, first.document);
          // The look's own size and place clear them from the track.
          yield* project.captions.setStyle(
            project.projectId,
            { custom: { position: "bottom", textColor: "#FFFFFF" } },
            { origin: "agent" },
          );
          const plainer = yield* project.edits.read(project.projectId);
          assert.deepStrictEqual(captionTracks(plainer.document)[0]!.custom, {
            textColor: "#FFFFFF",
          });
        }),
      ),
  );
});

// S7V-099 review: a clip placed after the captions that shows its own asks first, too.
describe("CaptionTrackService with a burned-in clip placed later (S7V-099)", () => {
  const twoClips = (project: Project) =>
    Effect.gen(function* () {
      writeClip(project.root, "cam");
      writeClip(project.root, "burnt", true, true);
      const initial = yield* project.edits.read(project.projectId);
      yield* project.edits.apply(
        project.projectId,
        [
          { _tag: "putMedia", media: mediaEntry("cam") },
          { _tag: "putMedia", media: mediaEntry("burnt") },
          {
            _tag: "addTrack",
            track: {
              kind: "video",
              id: "V1",
              items: [{ id: "v1", media: "cam", start: 0, duration: 240, in: 0 }],
            },
          },
        ],
        { origin: "agent", baseRevision: initial.revision },
      );
      yield* project.captions.addCaptions(project.projectId, {});
      const captioned = yield* project.edits.read(project.projectId);
      // The user places the clip that has captions in its picture after the first one.
      return yield* project.edits.apply(
        project.projectId,
        [
          {
            _tag: "insertItem",
            trackId: "V1",
            item: { id: "v2", media: "burnt", start: 240, duration: 240, in: 0 },
          },
        ],
        { origin: "timeline", baseRevision: captioned.revision },
      );
    });
  const captionedClips = (document: EditDocument) =>
    new Set(captionTracks(document)[0]!.items.map((item) => captionMediaOfItem(item)));

  it.effect(
    "the rebuild leaves it out; adding asks, naming the clip; restyles and looks go through",
    () =>
      withProject((project) =>
        Effect.gen(function* () {
          const placed = yield* twoClips(project);
          assert.deepStrictEqual(captionedClips(placed.document), new Set(["cam"]));
          const text = readEdit(project.root);
          // Adding captions would caption it: that asks, by its file name, with choices that fit.
          const refused = yield* project.captions
            .addCaptions(project.projectId, {})
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "CaptionsError");
          assert.include(
            refused.message,
            "burnt.mp4 already has captions near the bottom. Add ours at the top, add them anyway, or leave it as it is?",
          );
          assert.strictEqual(readEdit(project.root), text);
          // The user said "leave it as it is", then "make them bigger": the restyle goes through,
          // the clip stays uncaptioned, and the reply names it.
          const bigger = yield* project.captions.setStyle(
            project.projectId,
            { custom: { size: 1.4 } },
            { origin: "agent" },
          );
          assert.deepInclude(bigger, { changed: true, added: false, uncaptioned: ["burnt.mp4"] });
          const restyled = yield* project.edits.read(project.projectId);
          assert.deepStrictEqual(captionedClips(restyled.document), new Set(["cam"]));
          assert.deepStrictEqual(captionTracks(restyled.document)[0]!.custom, { size: 1.4 });
          const looks = yield* project.captions.looks(project.projectId, {});
          assert.deepStrictEqual(looks.uncaptioned, ["burnt.mp4"]);
          // A cut elsewhere rebuilds the captions and still leaves it out.
          const cut = yield* project.edits.apply(
            project.projectId,
            [{ _tag: "trimItem", itemId: "v1", edge: "end", frame: 200 }],
            { origin: "timeline", baseRevision: restyled.revision },
          );
          assert.deepStrictEqual(captionedClips(cut.document), new Set(["cam"]));
        }),
      ),
  );

  it.effect("a burned-in clip with no speech in its placed part never asks", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        writeClip(project.root, "burnt", true, true);
        const initial = yield* project.edits.read(project.projectId);
        yield* project.edits.apply(
          project.projectId,
          [
            { _tag: "putMedia", media: mediaEntry("cam") },
            { _tag: "putMedia", media: mediaEntry("burnt") },
            {
              _tag: "addTrack",
              track: {
                kind: "video",
                id: "V1",
                // The transcript's words end before frame 300: this part of the clip is silent.
                items: [
                  { id: "v1", media: "cam", start: 0, duration: 240, in: 0 },
                  { id: "v2", media: "burnt", start: 240, duration: 240, in: 600 },
                ],
              },
            },
          ],
          { origin: "agent", baseRevision: initial.revision },
        );
        assert.isTrue((yield* project.captions.addCaptions(project.projectId, {})).changed);
        const styled = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-box" },
          { origin: "agent" },
        );
        assert.deepStrictEqual(styled.uncaptioned, []);
      }),
    ),
  );

  it.effect("with the user's yes, one change captions it and restyles; later cuts keep it", () =>
    withProject((project) =>
      Effect.gen(function* () {
        const placed = yield* twoClips(project);
        const styled = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-box", custom: { position: "top" } },
          { origin: "agent", confirm: true },
        );
        assert.deepInclude(styled, { revision: placed.revision + 1, changed: true });
        const after = yield* project.edits.read(project.projectId);
        assert.deepStrictEqual(captionedClips(after.document), new Set(["cam", "burnt"]));
        assert.strictEqual(captionTracks(after.document)[0]!.style, "s7-box");
        // Asked once: rebuilding and restyling now ask nothing.
        assert.isFalse((yield* project.captions.addCaptions(project.projectId, {})).changed);
        const cut = yield* project.edits.apply(
          project.projectId,
          [{ _tag: "trimItem", itemId: "v1", edge: "end", frame: 200 }],
          { origin: "timeline", baseRevision: after.revision },
        );
        assert.deepStrictEqual(captionedClips(cut.document), new Set(["cam", "burnt"]));
      }),
    ),
  );

  it.effect("a colour for a part the look doesn't draw is refused plainly", () =>
    withProject((project) =>
      Effect.gen(function* () {
        writeClip(project.root, "cam");
        yield* setUp(project);
        const box = yield* project.captions
          .setStyle(
            project.projectId,
            { preset: "s7-neutral", custom: { boxColor: "#0A84FF" } },
            { origin: "agent" },
          )
          .pipe(Effect.flip);
        assert.strictEqual(box.message, 'The Plain look has no box. Say "boxed" to add one.');
        const lit = yield* project.captions
          .setStyle(
            project.projectId,
            { custom: { highlightColor: "#0A84FF" } },
            { origin: "agent" },
          )
          .pipe(Effect.flip);
        assert.include(lit.message, "The Plain look doesn't light up the word being said.");
        // A box colour kept from Boxed never stops a change to another look.
        yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-box", custom: { boxColor: "#0A84FF" } },
          { origin: "agent" },
        );
        const plain = yield* project.captions.setStyle(
          project.projectId,
          { preset: "s7-neutral" },
          { origin: "agent", reply },
        );
        assert.isTrue(plain.changed);
        const [newest] = yield* project.edits.versions(project.projectId);
        assert.deepStrictEqual(newest!.changes, ["Changed the caption look to Plain"]);
      }),
    ),
  );
});
