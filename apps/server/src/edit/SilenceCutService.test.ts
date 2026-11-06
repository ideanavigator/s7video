// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder and git directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type EditOp, type ProjectId, type Transcript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EngineService from "../engine/EngineService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { git, layerEditTest } from "./editHarness.testkit.ts";
import * as SilenceCutService from "./SilenceCutService.ts";

const FRAMES = 300;
const camera = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: FRAMES, hasVideo: true, hasAudio: true, fps: { num: 30, den: 1 } },
} as const;

/** Three spoken phrases with a second of room tone between them, at 30 fps. */
const PHRASES: ReadonlyArray<readonly [number, number]> = [
  [30, 90],
  [120, 180],
  [210, 270],
];

interface Scenario {
  words: ReadonlyArray<readonly [number, number]>;
  transcribed: boolean;
  /** Runs between the service reading the edit and writing it. */
  between: Effect.Effect<void>;
  detects: number;
}

const transcriptOf = (words: Scenario["words"]): Transcript => ({
  transcriptVersion: 1,
  mediaFingerprint: camera.fingerprint,
  model: "test",
  revision: "test",
  fps: { num: 30, den: 1 },
  durationFrames: FRAMES,
  words: words.map(([startFrame, endFrame], index) => ({
    text: `w${index}`,
    startFrame,
    endFrame,
    confidence: null,
    speaker: "S1",
  })),
  createdAt: "2026-11-06T00:00:00.000Z",
});

const levelsOf = (words: Scenario["words"]) => {
  const levels = Array.from({ length: FRAMES }, () => -50);
  for (const [from, to] of words) for (let at = from; at < to; at++) levels[at] = -18;
  return levels;
};

const withProject = <A, E>(
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly scenario: Scenario;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly silences: SilenceCutService.SilenceCutService["Service"];
  }) => Effect.Effect<A, E>,
  setup: ReadonlyArray<EditOp> = [{ _tag: "putMedia", media: camera }],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-silence-" });
    const scenario: Scenario = {
      words: PHRASES,
      transcribed: true,
      between: Effect.void,
      detects: 0,
    };
    const engine = Layer.mock(EngineService.EngineService)({
      call: (method) =>
        method === "silence.detect"
          ? Effect.sync(() => {
              scenario.detects++;
              return {
                rate: { num: 30, den: 1 },
                durationFrames: FRAMES,
                levels: levelsOf(scenario.words),
              } as never;
            })
          : Effect.die(`unexpected ${method}`),
    });
    const transcripts = Layer.mock(TranscriptService.TranscriptService)({
      get: () =>
        scenario.between.pipe(
          Effect.andThen(
            Effect.sync(() => (scenario.transcribed ? transcriptOf(scenario.words) : null)),
          ),
        ),
    });
    const services = SilenceCutService.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(engine, transcripts)),
      Layer.provideMerge(layerEditTest(baseDir)),
    );
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const silences = yield* SilenceCutService.SilenceCutService;
      const created = yield* folders.createNamedProject({ name: "Silence test" });
      const root = created.workspaceRoot;
      NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), "original media");
      const initial = yield* edits.read(created.projectId);
      yield* edits.apply(created.projectId, setup, {
        origin: "agent",
        baseRevision: initial.revision,
      });
      return yield* body({ projectId: created.projectId, root, scenario, edits, silences });
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readEdit = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

describe("SilenceCutService", () => {
  it.effect("cuts as one checkpoint, repeats as a no-op, and undo restores the edit", () =>
    withProject(({ projectId, root, edits, silences }) =>
      Effect.gen(function* () {
        const before = readEdit(root);
        const media = NodePath.join(root, "assets", "cam.mp4");
        const mediaStat = NodeFS.statSync(media);
        const start = yield* edits.read(projectId);

        const first = yield* silences.removeSilences({ projectId });
        assert.deepEqual(first, {
          media: "cam",
          removedSeconds: 3.4,
          cuts: 4,
          keptSegments: 3,
          shortestSegmentFrames: 66,
          keptRequests: 0,
          message: "Removed 3.4 s in 4 cuts. This only cuts more; it never restores earlier cuts.",
          revision: start.revision + 1,
          changed: true,
        });
        const cut = yield* edits.read(projectId);
        const track = cut.document.tracks[0]!;
        assert.strictEqual(track.kind, "video");
        assert.deepEqual(
          track.items.map((item) => [item.start, "in" in item ? item.in : -1, item.duration]),
          [
            [0, 27, 66],
            [66, 117, 66],
            [132, 207, 66],
          ],
        );
        const afterCut = readEdit(root);
        const checkpoints = git(root, "for-each-ref").trim();

        // AC-8: the same request again changes no byte and records no checkpoint.
        const again = yield* silences.removeSilences({ projectId });
        assert.isFalse(again.changed);
        assert.strictEqual(again.revision, first.revision);
        assert.strictEqual(readEdit(root), afterCut);
        assert.strictEqual(git(root, "for-each-ref").trim(), checkpoints);

        // AC-7: one undo brings the previous edit back byte for byte; the media is untouched.
        yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), before);
        assert.strictEqual(NodeFS.readFileSync(media, "utf8"), "original media");
        assert.strictEqual(NodeFS.statSync(media).mtimeMs, mediaStat.mtimeMs);
      }),
    ),
  );

  it.effect("a tighter second pass cuts more with unique ids and never restores a cut", () =>
    withProject(({ projectId, root, scenario, edits, silences }) =>
      Effect.gen(function* () {
        // A third of a second inside the first phrase: kept at 0.4 s, cut at 0.25 s.
        scenario.words = [[30, 55], [65, 90], ...PHRASES.slice(1)];
        const spans = Effect.map(edits.read(projectId), ({ document }) =>
          document.tracks[0]!.items.map((item) => ({
            id: item.id,
            from: "in" in item ? item.in : -1,
            to: ("in" in item ? item.in : -1) + item.duration,
          })),
        );
        const plays = (items: ReadonlyArray<{ from: number; to: number }>, frame: number) =>
          items.some(({ from, to }) => from <= frame && frame < to);

        const first = yield* silences.removeSilences({ projectId });
        assert.isTrue(first.changed);
        const afterFirst = yield* spans;
        assert.strictEqual(afterFirst.length, 3);

        const tighter = yield* silences.removeSilences({ projectId, minGapSeconds: 0.25 });
        assert.isTrue(tighter.changed);
        assert.strictEqual(tighter.cuts, 1);
        const afterTighter = yield* spans;
        assert.strictEqual(afterTighter.length, 4);
        assert.strictEqual(new Set(afterTighter.map((item) => item.id)).size, 4);
        assert.isFalse(plays(afterTighter, 60));
        for (let frame = 0; frame < FRAMES; frame++) {
          if (!plays(afterFirst, frame)) assert.isFalse(plays(afterTighter, frame), `${frame}`);
        }

        // A third pass, at either threshold, finds nothing new and brings nothing back.
        const afterTighterText = readEdit(root);
        for (const minGapSeconds of [undefined, 0.25]) {
          const again = yield* silences.removeSilences({
            projectId,
            ...(minGapSeconds === undefined ? {} : { minGapSeconds }),
          });
          assert.isFalse(again.changed);
          assert.strictEqual(again.cuts, 0);
          assert.strictEqual(readEdit(root), afterTighterText);
        }
      }),
    ),
  );

  it.effect("keeps a pause the user asked for", () =>
    withProject(({ projectId, edits, silences }) =>
      Effect.gen(function* () {
        const kept = yield* silences.removeSilences({
          projectId,
          keep: [{ fromFrame: 95, toFrame: 115 }],
        });
        assert.strictEqual(kept.keptRequests, 1);
        assert.strictEqual(kept.cuts, 3);
        const items = (yield* edits.read(projectId)).document.tracks[0]!.items;
        assert.isTrue(
          items.some((item) => "in" in item && item.in <= 95 && item.in + item.duration >= 115),
        );
      }),
    ),
  );

  it.effect("a removed retake stays removed, and a second run changes nothing", () =>
    withProject(
      ({ projectId, root, edits, silences }) =>
        Effect.gen(function* () {
          const first = yield* silences.removeSilences({ projectId });
          assert.isTrue(first.changed);
          const items = (yield* edits.read(projectId)).document.tracks[0]!.items;
          for (const item of items) {
            const from = "in" in item ? item.in : -1;
            assert.isTrue(from + item.duration <= 115 || from >= 185, `item at ${from}`);
          }
          const afterFirst = readEdit(root);
          const again = yield* silences.removeSilences({ projectId });
          assert.isFalse(again.changed);
          assert.strictEqual(again.cuts, 0);
          assert.strictEqual(readEdit(root), afterFirst);
        }),
      // The middle phrase (a retake) was removed by hand: only 0-115 and 185-300 play.
      [
        { _tag: "putMedia", media: camera },
        { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
        {
          _tag: "setKeepRanges",
          trackId: "V1",
          mediaId: "cam",
          ranges: [
            { in: 0, duration: 115 },
            { in: 185, duration: 115 },
          ],
        },
      ],
    ),
  );

  it.effect("refuses a keep that starts after the clip ends", () =>
    withProject(({ projectId, root, silences }) =>
      Effect.gen(function* () {
        const before = readEdit(root);
        const error = yield* silences
          .removeSilences({ projectId, keep: [{ fromFrame: 5000, toFrame: 6000 }] })
          .pipe(Effect.flip);
        assert.strictEqual(
          error.message,
          "keep 5000-6000 starts after the clip ends (300 frames).",
        );
        assert.strictEqual(readEdit(root), before);
      }),
    ),
  );

  it.effect("should handle missing transcript", () =>
    withProject(({ projectId, root, scenario, silences }) =>
      Effect.gen(function* () {
        scenario.transcribed = false;
        const before = readEdit(root);
        const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SilenceCutError");
        assert.include(error.message, "Run video_transcribe first");
        assert.strictEqual(scenario.detects, 0);
        assert.strictEqual(readEdit(root), before);
      }),
    ),
  );

  it.effect("should handle an all-silent clip by refusing to remove everything", () =>
    withProject(({ projectId, root, scenario, silences }) =>
      Effect.gen(function* () {
        scenario.words = [];
        const before = readEdit(root);
        const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
        assert.strictEqual(error._tag === "SilenceCutError" && error.reason, "no-speech");
        assert.strictEqual(readEdit(root), before);
      }),
    ),
  );

  it.effect("should handle a clip with no silence: no change and no checkpoint", () =>
    withProject(({ projectId, root, scenario, edits, silences }) =>
      Effect.gen(function* () {
        scenario.words = [[0, FRAMES]];
        const before = yield* edits.read(projectId);
        const beforeText = readEdit(root);
        const result = yield* silences.removeSilences({ projectId });
        assert.strictEqual(result.cuts, 0);
        assert.strictEqual(result.removedSeconds, 0);
        assert.isFalse(result.changed);
        assert.strictEqual(result.revision, before.revision);
        assert.strictEqual(readEdit(root), beforeText);
      }),
    ),
  );

  it.effect("should reject stale base revision", () =>
    withProject(({ projectId, root, scenario, edits, silences }) =>
      Effect.gen(function* () {
        // Another edit lands while the service plans.
        scenario.between = Effect.gen(function* () {
          scenario.between = Effect.void;
          const current = yield* edits.read(projectId);
          yield* edits.apply(
            projectId,
            [{ _tag: "addTrack", track: { kind: "caption", id: "C1", items: [] } }],
            { origin: "timeline", baseRevision: current.revision },
          );
        }).pipe(Effect.orDie);
        const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "EditConflict");
        assert.notInclude(readEdit(root), '"V1"');
      }),
    ),
  );

  it.effect("refuses a clip with linked sound on another track", () =>
    withProject(
      ({ projectId, root, silences }) =>
        Effect.gen(function* () {
          const before = readEdit(root);
          const error = yield* silences
            .removeSilences({ projectId, media: "cam" })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag === "SilenceCutError" && error.reason, "linked-audio");
          assert.strictEqual(readEdit(root), before);
        }),
      [
        { _tag: "putMedia", media: camera },
        { _tag: "addTrack", track: { kind: "sfx", id: "A1", items: [] } },
        {
          _tag: "insertItem",
          trackId: "A1",
          item: { media: "cam", start: 0, duration: 30, in: 0 },
        } as EditOp,
      ],
    ),
  );
});
