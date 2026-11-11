// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The fake engine writes stills; the test writes a clip and its transcript.
/**
 * S7V-075: the player's caption stills are the captions the export burns in: the caption track,
 * or with none, the clips' transcripts (the export's fallback). The engine is faked here, keeping
 * one still per text as the real one does; `test_captions.py` covers the real drawing and cache.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CaptionStillsResult,
  type EditOp,
  type ProjectId,
  type Transcript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { layerEditTest } from "../edit/editHarness.testkit.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CaptionStillsService from "./CaptionStillsService.ts";

interface RenderParams {
  readonly edit: {
    readonly tracks: ReadonlyArray<{
      readonly kind: string;
      readonly muted?: boolean;
      readonly items: ReadonlyArray<{ start: number; duration: number; text: string }>;
    }>;
  };
  readonly cacheDir: string;
  readonly transcripts?: ReadonlyArray<{
    readonly media: string;
    readonly words: ReadonlyArray<{ text: string; startFrame: number; endFrame: number }>;
  }>;
}

interface Calls {
  readonly renders: Array<RenderParams>;
  drawn: number;
  /** The bytes of a new still; a short marker by default. */
  stillBytes?: (text: string) => Uint8Array;
}

const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
/** Named as the engine names them: 32 hex digits for the look, and for each text. */
const LOOK = sha("look").slice(0, 32);
const stillName = (text: string) => `${sha(text).slice(0, 32)}.png`;

/** Answers `captions.render` as the engine does: the track's chunks, else the transcripts'. */
const fakeEngine = (calls: Calls) =>
  Layer.mock(EngineService.EngineService)({
    call: (_method, params, success) =>
      Effect.gen(function* () {
        const input = params as unknown as RenderParams;
        calls.renders.push(input);
        const items = input.edit.tracks
          .filter((track) => track.kind === "caption" && track.muted !== true)
          .flatMap((track) => track.items);
        const hasItems = input.edit.tracks.some(
          (track) => track.kind === "caption" && track.items.length > 0,
        );
        const chunks = hasItems
          ? items.map((item) => ({
              start: item.start,
              end: item.start + item.duration,
              text: item.text,
            }))
          : (input.transcripts ?? []).flatMap((transcript) =>
              transcript.words.map((word) => ({
                start: word.startFrame,
                end: word.endFrame,
                text: word.text,
              })),
            );
        const folder = NodePath.join(input.cacheDir, LOOK);
        NodeFS.mkdirSync(folder, { recursive: true });
        for (const text of new Set(chunks.map((chunk) => chunk.text))) {
          const file = NodePath.join(folder, stillName(text));
          if (NodeFS.existsSync(file)) continue;
          NodeFS.writeFileSync(file, calls.stillBytes?.(text) ?? `png:${text}`);
          calls.drawn += 1;
        }
        return yield* Schema.decodeEffect(success)({
          width: 1080,
          height: 1920,
          folder: LOOK,
          drawn: 0,
          chunks: chunks.map((chunk) => ({
            start: chunk.start,
            end: chunk.end,
            png: stillName(chunk.text),
          })),
        }).pipe(Effect.orDie);
      }),
  });

const clip = Buffer.from("a talking-head clip");
const clipFingerprint = { sha256: sha(clip.toString()), size: clip.length };

const media = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  label: "cam.mp4",
  fingerprint: clipFingerprint,
  probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
} as const;

const writeClip = (root: string, transcribed: boolean) => {
  NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), clip);
  if (!transcribed) return;
  const transcript: Transcript = {
    transcriptVersion: 1,
    mediaFingerprint: clipFingerprint,
    model: "test",
    revision: "test",
    fps: { num: 30, den: 1 },
    durationFrames: 900,
    words: [
      { text: "hello", startFrame: 0, endFrame: 10, confidence: 1, speaker: "S1" },
      { text: "there", startFrame: 12, endFrame: 20, confidence: 1, speaker: "S1" },
    ],
    createdAt: "2026-11-09T00:00:00.000Z",
  };
  const dir = NodePath.join(root, ".s7cache", "transcripts");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, `${clipFingerprint.sha256}.json`),
    JSON.stringify(transcript),
  );
};

const video: ReadonlyArray<EditOp> = [
  { _tag: "putMedia", media },
  {
    _tag: "addTrack",
    track: {
      kind: "video",
      id: "V1",
      items: [{ id: "v1", media: "cam", start: 0, duration: 90, in: 0 }],
    },
  },
];
/** A caption track written by hand: never rebuilt from the transcripts. */
const captionTrack: EditOp = { _tag: "addTrack", track: { kind: "caption", id: "C1", items: [] } };
/** The track "add captions" writes, with items that name their clip. */
const transcriptTrack: EditOp = {
  _tag: "addTrack",
  track: { kind: "caption", id: "C1", metadata: { s7: { source: "transcript" } }, items: [] },
};

const captions = (texts: ReadonlyArray<string>, metadata?: { s7: { media: string } }): EditOp => ({
  _tag: "setCaptions",
  trackId: "C1",
  captions: texts.map((text, index) => ({
    start: index * 20,
    duration: 15,
    text,
    ...(metadata === undefined ? {} : { metadata }),
  })),
});

/** S7V-075's measured 10-minute talk: 534 chunks over 452 texts, about 21 KB per PNG still. */
const TEN_MINUTES = 10 * 60 * 30;
const LONG_CHUNKS = 534;
const LONG_TEXTS = 452;
const longEdit: ReadonlyArray<EditOp> = [
  { _tag: "putMedia", media: { ...media, probe: { ...media.probe, durationFrames: TEN_MINUTES } } },
  {
    _tag: "addTrack",
    track: {
      kind: "video",
      id: "V1",
      items: [{ id: "v1", media: "cam", start: 0, duration: TEN_MINUTES, in: 0 }],
    },
  },
  captionTrack,
  {
    _tag: "setCaptions",
    trackId: "C1",
    captions: Array.from({ length: LONG_CHUNKS }, (_, index) => ({
      start: index * 33,
      duration: 30,
      text: `spoken words number ${index % LONG_TEXTS}`,
    })),
  },
];

const withStills = <A, E>(
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly calls: Calls;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly stills: CaptionStillsService.CaptionStillsService["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-stills-" });
    const calls: Calls = { renders: [], drawn: 0 };
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const created = yield* folders.createNamedProject({ name: "Stills test" });
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        calls,
        edits: yield* EditDocumentService.EditDocumentService,
        stills: yield* CaptionStillsService.CaptionStillsService,
      });
    }).pipe(
      Effect.provide(
        CaptionStillsService.layer.pipe(
          Layer.provide(fakeEngine(calls)),
          Layer.provideMerge(layerEditTest(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const apply = (
  edits: EditDocumentService.EditDocumentService["Service"],
  projectId: ProjectId,
  ops: ReadonlyArray<EditOp>,
) =>
  edits
    .read(projectId)
    .pipe(
      Effect.flatMap((snapshot) =>
        edits.apply(projectId, ops, { origin: "agent", baseRevision: snapshot.revision }),
      ),
    );

const encodeReply = Schema.encodeSync(CaptionStillsResult);
const replyBytes = (result: CaptionStillsResult) =>
  Buffer.byteLength(JSON.stringify(encodeReply(result)));

const decoded = (stills: ReadonlyArray<string>) =>
  stills.map((still) => Buffer.from(still, "base64").toString());

describe("CaptionStillsService (S7V-075)", () => {
  it.effect("serves the track's stills, one per text, and serves undo without drawing", () =>
    withStills(({ projectId, root, calls, edits, stills }) =>
      Effect.gen(function* () {
        writeClip(root, true);
        yield* apply(edits, projectId, [
          ...video,
          captionTrack,
          captions(["hello there", "again", "hello there"]),
        ]);
        const first = yield* stills.stills(projectId);
        assert.deepStrictEqual(first.chunks, [
          { start: 0, end: 15, still: 0 },
          { start: 20, end: 35, still: 1 },
          { start: 40, end: 55, still: 0 },
        ]);
        assert.deepStrictEqual(decoded(first.stills), ["png:hello there", "png:again"]);
        assert.deepStrictEqual(first.missing, []);
        // A track with items never sends the transcripts.
        assert.isUndefined(calls.renders[0]!.transcripts);
        assert.strictEqual(calls.renders[0]!.cacheDir, NodePath.join(root, ".s7cache", "captions"));
        assert.strictEqual(calls.drawn, 2);

        yield* apply(edits, projectId, [captions(["new words"])]);
        const changed = yield* stills.stills(projectId);
        assert.notStrictEqual(changed.key, first.key);
        assert.strictEqual(calls.drawn, 3);
        yield* edits.undo(projectId);
        assert.deepStrictEqual(yield* stills.stills(projectId), first);
        assert.strictEqual(calls.drawn, 3);
      }),
    ),
  );

  it.effect("with no caption track, shows the transcript captions the export burns in", () =>
    withStills(({ projectId, root, calls, edits, stills }) =>
      Effect.gen(function* () {
        writeClip(root, true);
        yield* apply(edits, projectId, video);
        const fallback = yield* stills.stills(projectId);
        assert.deepStrictEqual(decoded(fallback.stills), ["png:hello", "png:there"]);
        assert.deepStrictEqual(
          calls.renders[0]!.transcripts?.map((entry) => entry.media),
          ["cam"],
        );
        // An empty caption track still falls back, as in the export.
        yield* apply(edits, projectId, [captionTrack]);
        assert.deepStrictEqual((yield* stills.stills(projectId)).chunks, fallback.chunks);
      }),
    ),
  );

  it.effect("names a clip whose transcript can't be read", () =>
    withStills(({ projectId, root, calls, edits, stills }) =>
      Effect.gen(function* () {
        writeClip(root, false);
        yield* apply(edits, projectId, video);
        yield* apply(edits, projectId, [
          transcriptTrack,
          captions(["kept words"], { s7: { media: "cam" } }),
        ]);
        const result = yield* stills.stills(projectId);
        assert.deepStrictEqual(result.missing, ["cam.mp4"]);
        assert.deepStrictEqual(decoded(result.stills), ["png:kept words"]);
        assert.strictEqual(calls.renders.length, 1);
      }),
    ),
  );

  it.effect("a muted caption track, or nothing to caption, calls no engine", () =>
    withStills(({ projectId, root, calls, edits, stills }) =>
      Effect.gen(function* () {
        writeClip(root, false);
        yield* apply(edits, projectId, video);
        const none = yield* stills.stills(projectId);
        assert.deepStrictEqual({ chunks: none.chunks, key: none.key }, { chunks: [], key: "none" });
        yield* apply(edits, projectId, [
          captionTrack,
          captions(["hello"]),
          { _tag: "setTrackProps", trackId: "C1", props: { muted: true } },
        ]);
        assert.deepStrictEqual((yield* stills.stills(projectId)).stills, []);
        assert.strictEqual(calls.renders.length, 0);
      }),
    ),
  );

  it.effect("S7V-079: the reply for a 10-minute edit stays under 200 KB", () =>
    withStills(({ projectId, root, calls, edits, stills }) =>
      Effect.gen(function* () {
        writeClip(root, false);
        calls.stillBytes = () => NodeCrypto.randomBytes(21_000);
        yield* apply(edits, projectId, longEdit);
        const result = yield* stills.stills(projectId);
        assert.strictEqual(result.chunks.length, LONG_CHUNKS);
        assert.strictEqual(calls.drawn, LONG_TEXTS);
        const bytes = replyBytes(result);
        console.info(
          `captions.stills for 10 minutes: ${LONG_CHUNKS} chunks, ${LONG_TEXTS} stills, ${(bytes / 1000).toFixed(1)} KB`,
        );
        assert.isBelow(bytes, 200_000);
      }),
    ),
  );
});
