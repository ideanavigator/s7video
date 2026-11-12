// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder and git directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EngineError,
  EngineJobId,
  type EditDocument,
  type EditOp,
  type ProjectId,
  type Transcript,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EngineService from "../engine/EngineService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { historyLog, layerEditTest } from "./editHarness.testkit.ts";
import * as SilenceCutService from "./SilenceCutService.ts";
import { zoomOps } from "./zoomOps.ts";

const FRAMES = 300;
const camera = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: FRAMES, hasVideo: true, hasAudio: true, fps: { num: 30, den: 1 } },
} as const;

/** A wide 1894×1080 recording, as the S7V-021 talking-head clip. */
const wideCamera = {
  ...camera,
  probe: { ...camera.probe, width: 1894, height: 1080 },
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
  /** Whether `<sha256>.levels.json` is there and matches the transcript (S7V-055). */
  levelsCached: boolean;
  /** `silence` jobs started, with what they were given. */
  jobs: Array<{ kind: string; method: string; params: unknown; projectId: unknown }>;
  /** Runs inside each `silence` job before it succeeds (a gate, or a failure). */
  job: Effect.Effect<void, EngineError>;
  /** What each `silence` job measures, when not the transcript's own clock. */
  measured: { rate: { num: number; den: number }; durationFrames: number };
  /** Runs in each `silence` job before it has its id. */
  beforeStart: Effect.Effect<void>;
  /** Runs on each `levels` read. */
  asked: Effect.Effect<void>;
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
      levelsCached: true,
      jobs: [],
      job: Effect.void,
      beforeStart: Effect.void,
      asked: Effect.void,
      measured: { rate: { num: 30, den: 1 }, durationFrames: FRAMES },
    };
    const engine = Layer.mock(EngineService.EngineService)({
      // No quick engine call at all: the levels come from the cache file or a job.
      call: (method) => Effect.die(`unexpected quick call ${method}`),
      runJob: (input) =>
        Effect.gen(function* () {
          scenario.jobs.push({
            kind: input.kind,
            method: input.method,
            params: input.params,
            projectId: input.projectId,
          });
          yield* scenario.beforeStart;
          if (input.onStart) {
            yield* input.onStart(EngineJobId.make(`engine-job-${scenario.jobs.length}`));
          }
          yield* scenario.job;
          // The job wrote the levels file.
          scenario.levelsCached = true;
          return {
            ...scenario.measured,
            levels: levelsOf(scenario.words).slice(0, scenario.measured.durationFrames),
          } as never;
        }),
    });
    const transcripts = Layer.mock(TranscriptService.TranscriptService)({
      // Only `levels`: one read gives the transcript and its levels (S7V-055 review).
      levels: () =>
        scenario.between.pipe(
          Effect.andThen(scenario.asked),
          Effect.andThen(
            Effect.sync(() => ({
              transcript: scenario.transcribed ? transcriptOf(scenario.words) : null,
              cached: scenario.levelsCached
                ? {
                    levelsVersion: 1 as const,
                    mediaFingerprint: camera.fingerprint,
                    fps: { num: 30, den: 1 },
                    durationFrames: FRAMES,
                    levels: levelsOf(scenario.words),
                  }
                : null,
              measure: {
                projectId: "project" as ProjectId,
                path: "/project/assets/cam.mp4",
                cacheDir: "/project/.s7cache/transcripts",
                fingerprint: camera.fingerprint,
              },
            })),
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
        // A clip whose probe has no picture size leaves the canvas as it was.
        assert.deepEqual(cut.document.canvas, start.document.canvas);
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
        const checkpoints = historyLog(root);

        // AC-8: the same request again changes no byte and records no checkpoint.
        const again = yield* silences.removeSilences({ projectId });
        assert.isFalse(again.changed);
        assert.strictEqual(again.revision, first.revision);
        assert.strictEqual(readEdit(root), afterCut);
        assert.deepEqual(historyLog(root), checkpoints);

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

        // Undo gives pass 1 back exactly, and redo the tighter cut, ids included.
        yield* edits.undo(projectId);
        assert.deepEqual(yield* spans, afterFirst);
        yield* edits.redo(projectId);
        assert.deepEqual(yield* spans, afterTighter);

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

  // S7V-037 (AC-11): a later silence cut keeps a punch-in on every part of it that survives.
  it.effect("a tighter pass keeps the zoom on the kept parts of a zoomed item, in one undo", () =>
    withProject(({ projectId, root, scenario, edits, silences }) =>
      Effect.gen(function* () {
        scenario.words = [[30, 55], [65, 90], ...PHRASES.slice(1)];
        yield* silences.removeSilences({ projectId });
        const first = yield* edits.read(projectId);
        const target = first.document.tracks[0]!.items.toSorted((a, b) => a.start - b.start)[0]!;
        const from = "in" in target ? target.in : -1;
        const zoom = { scale: 1.4, anchorX: 0.45, anchorY: 0.3, rampFrames: 0 };
        yield* edits.apply(
          projectId,
          zoomOps(
            first.document,
            [{ start: target.start, end: target.start + target.duration }],
            zoom,
          ).ops,
          { origin: "agent", baseRevision: first.revision },
        );
        const zoomedText = readEdit(root);
        const tighter = yield* silences.removeSilences({ projectId, minGapSeconds: 0.25 });
        assert.isTrue(tighter.changed);
        const after = (yield* edits.read(projectId)).document.tracks[0]!.items;
        const inside = (item: (typeof after)[number]) =>
          "in" in item && item.in >= from && item.in + item.duration <= from + target.duration;
        // The pause inside the zoomed item was cut: both sides keep the same zoom, nothing else has it.
        assert.isAtLeast(after.filter(inside).length, 2);
        for (const item of after) {
          assert.deepStrictEqual(
            "zoom" in item ? item.zoom : undefined,
            inside(item) ? zoom : undefined,
          );
        }
        // Still one change: one undo gives the zoomed edit back exactly.
        yield* edits.undo(projectId);
        assert.strictEqual(readEdit(root), zoomedText);
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

  it.effect("message names already-cut keeps", () =>
    withProject(
      ({ projectId, root, silences }) =>
        Effect.gen(function* () {
          // 130-150 lies in the retake removed by hand: it stays cut, the other pauses go.
          const first = yield* silences.removeSilences({
            projectId,
            keep: [{ fromFrame: 130, toFrame: 150 }],
          });
          assert.isTrue(first.changed);
          assert.strictEqual(first.keptRequests, 0);
          assert.match(
            first.message,
            /^Removed .* s in \d+ cuts\. This only cuts more; it never restores earlier cuts\. /,
          );
          assert.isTrue(
            first.message.endsWith(
              " The pause you asked to keep at clip frames 130-150 was cut by an earlier edit, so it stays cut. To get it back, undo until that pause plays again, then ask to keep it.",
            ),
          );
          // One undo would only take back this call's cuts: the message must not promise it.
          assert.notInclude(first.message, "say undo");
          const afterFirst = readEdit(root);

          // Nothing new to cut: the sentence follows the unchanged message.
          const again = yield* silences.removeSilences({
            projectId,
            keep: [
              { fromFrame: 130, toFrame: 150 },
              { fromFrame: 160, toFrame: 170 },
            ],
          });
          assert.isFalse(again.changed);
          assert.strictEqual(again.keptRequests, 0);
          assert.strictEqual(
            again.message,
            "No more pauses to cut; the edit is unchanged. The pauses you asked to keep at clip frames 130-150 and 160-170 were cut by an earlier edit, so they stay cut. To get them back, undo until those pauses play again, then ask to keep them.",
          );
          assert.strictEqual(readEdit(root), afterFirst);
        }),
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

  it.effect("first placement of a wide clip sets a wide canvas", () =>
    withProject(
      ({ projectId, root, edits, silences }) =>
        Effect.gen(function* () {
          const before = readEdit(root);
          const start = yield* edits.read(projectId);
          assert.deepEqual(start.document.canvas, { width: 1080, height: 1920 });

          const first = yield* silences.removeSilences({ projectId });
          assert.strictEqual(first.revision, start.revision + 1);
          const cut = yield* edits.read(projectId);
          assert.deepEqual(cut.document.canvas, { width: 1894, height: 1080 });
          assert.strictEqual(cut.document.tracks[0]!.items.length, 3);

          // The canvas and the cut are one checkpoint: one undo takes both back.
          yield* edits.undo(projectId);
          assert.strictEqual(readEdit(root), before);
        }),
      [{ _tag: "putMedia", media: wideCamera }],
    ),
  );

  it.effect("keeps a canvas the user chose before the first cut", () =>
    withProject(
      ({ projectId, edits, silences }) =>
        Effect.gen(function* () {
          const first = yield* silences.removeSilences({ projectId });
          assert.isTrue(first.changed);
          // Chosen on an empty timeline, even though it equals the default: the wide cut keeps it.
          const cut = yield* edits.read(projectId);
          assert.deepEqual(cut.document.canvas, { width: 1080, height: 1920 });
          assert.strictEqual(cut.document.tracks[0]!.items.length, 3);
        }),
      [
        { _tag: "putMedia", media: wideCamera },
        { _tag: "setCanvas", canvas: { width: 1080, height: 1920 } },
      ],
    ),
  );

  it.effect("keeps the canvas when the timeline already has a clip", () =>
    withProject(
      ({ projectId, edits, silences }) =>
        Effect.gen(function* () {
          const first = yield* silences.removeSilences({ projectId });
          assert.isTrue(first.changed);
          const cut = yield* edits.read(projectId);
          // The user chose this shape after placing the clip; a later cut never resets it.
          assert.deepEqual(cut.document.canvas, { width: 1080, height: 1080 });
        }),
      [
        { _tag: "putMedia", media: wideCamera },
        { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
        {
          _tag: "setKeepRanges",
          trackId: "V1",
          mediaId: "cam",
          ranges: [{ in: 0, duration: FRAMES }],
        },
        // Not marked chosen, so only the placed clip keeps the first cut from reshaping.
        { _tag: "setCanvas", canvas: { width: 1080, height: 1080 }, fromClip: true },
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

  it.effect("reads cached levels and calls no engine method (S7V-055)", () =>
    withProject(({ projectId, scenario, silences }) =>
      Effect.gen(function* () {
        const result = yield* silences.removeSilences({ projectId });
        assert.strictEqual(result.cuts, 4);
        yield* silences.removeSilences({ projectId, minGapSeconds: 0.25 });
        // The fake engine dies on any quick call, and no job ran.
        assert.deepEqual(scenario.jobs, []);
      }),
    ),
  );

  it.effect("runs a silence job when levels are missing, and the next run reads its file", () =>
    withProject(({ projectId, scenario, silences }) =>
      Effect.gen(function* () {
        scenario.levelsCached = false;
        const first = yield* silences.removeSilences({ projectId });
        // The same cut as from cached levels.
        assert.strictEqual(first.cuts, 4);
        assert.strictEqual(first.removedSeconds, 3.4);
        assert.deepEqual(scenario.jobs, [
          {
            kind: "silence",
            method: "silence.detect",
            params: {
              path: "/project/assets/cam.mp4",
              cacheDir: "/project/.s7cache/transcripts",
              fingerprint: camera.fingerprint,
            },
            projectId: "project",
          },
        ]);
        assert.isTrue(scenario.levelsCached);
        const second = yield* silences.removeSilences({ projectId });
        assert.isFalse(second.changed);
        assert.strictEqual(scenario.jobs.length, 1);
      }),
    ),
  );

  it.effect("hands the job back when measuring outlasts the wait, and reuses it", () =>
    withProject(({ projectId, root, scenario, silences }) =>
      Effect.gen(function* () {
        const running = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        scenario.levelsCached = false;
        scenario.job = Deferred.succeed(running, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        const before = readEdit(root);
        const waitedOut = Effect.gen(function* () {
          const call = yield* silences
            .removeSilences({ projectId })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(running);
          // Moves the clock past the 20 s wait however far the call has got.
          while (call.pollUnsafe() === undefined) yield* TestClock.adjust("5 seconds");
          return yield* Fiber.join(call);
        });
        const waiting = yield* waitedOut;
        assert.strictEqual(waiting._tag === "SilenceCutError" && waiting.reason, "measuring");
        assert.strictEqual(
          waiting.message,
          "Measuring the sound of cam first (video job engine-job-1). Wait for it with video_job_status, then call video_remove_silences again.",
        );
        assert.strictEqual(readEdit(root), before);
        // Asked again while it runs: the same job, not a second one.
        const again = yield* waitedOut;
        assert.include(again.message, "engine-job-1");
        assert.strictEqual(scenario.jobs.length, 1);
        // The job goes on although no call waits for it; the next call gets its levels.
        yield* Deferred.succeed(gate, undefined);
        const done = yield* silences.removeSilences({ projectId });
        assert.strictEqual(done.cuts, 4);
        assert.strictEqual(scenario.jobs.length, 1);
      }),
    ),
  );

  it.effect("two calls at once share one silence job, even before it has its id", () =>
    withProject(({ projectId, scenario, silences }) =>
      Effect.gen(function* () {
        const bothAsked = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let asks = 0;
        scenario.levelsCached = false;
        scenario.asked = Effect.suspend(() =>
          ++asks === 2 ? Deferred.succeed(bothAsked, undefined) : Effect.void,
        ).pipe(Effect.asVoid);
        // The job gets its id only once both calls have read the (missing) levels.
        scenario.beforeStart = Deferred.await(bothAsked).pipe(Effect.andThen(Deferred.await(gate)));
        const call = silences.removeSilences({ projectId }).pipe(Effect.exit);
        const both = yield* Effect.all([call, call], { concurrency: "unbounded" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(bothAsked);
        yield* Deferred.succeed(gate, undefined);
        const outcomes = yield* Fiber.join(both);
        assert.strictEqual(scenario.jobs.length, 1);
        // Both planned from the same edit: one cuts, the other finds it changed meanwhile.
        const cut = outcomes.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value.cuts] : []));
        assert.deepEqual(cut, [4]);
      }),
    ),
  );

  it.effect("a caller cut off while the job runs leaves it running for the next call", () =>
    withProject(({ projectId, scenario, silences }) =>
      Effect.gen(function* () {
        const running = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        scenario.levelsCached = false;
        scenario.job = Deferred.succeed(running, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        const call = yield* silences.removeSilences({ projectId }).pipe(Effect.forkChild);
        yield* Deferred.await(running);
        yield* Fiber.interrupt(call);
        yield* Deferred.succeed(gate, undefined);
        const next = yield* silences.removeSilences({ projectId });
        assert.strictEqual(next.cuts, 4);
        assert.strictEqual(scenario.jobs.length, 1);
      }),
    ),
  );

  it.effect("refuses levels measured on another clock than the transcript's", () =>
    withProject(({ projectId, root, scenario, silences }) =>
      Effect.gen(function* () {
        scenario.levelsCached = false;
        const before = readEdit(root);
        for (const measured of [
          { rate: { num: 30, den: 1 }, durationFrames: FRAMES - 1 },
          { rate: { num: 25, den: 1 }, durationFrames: FRAMES },
        ]) {
          scenario.measured = measured;
          const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
          assert.strictEqual(error._tag === "SilenceCutError" && error.reason, "no-transcript");
          assert.strictEqual(
            error.message,
            "cam changed since it was transcribed. Run video_transcribe again.",
          );
          assert.strictEqual(readEdit(root), before);
          scenario.levelsCached = false;
        }
        assert.strictEqual(scenario.jobs.length, 2);
      }),
    ),
  );

  it.effect("a cancelled silence job says so, and the next run measures again", () =>
    withProject(({ projectId, root, scenario, silences }) =>
      Effect.gen(function* () {
        scenario.levelsCached = false;
        scenario.job = Effect.fail(
          new EngineError({ reason: "cancelled", method: "silence.detect" }),
        );
        const before = readEdit(root);
        const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
        assert.strictEqual(error._tag === "EngineError" && error.reason, "cancelled");
        assert.include(error.message, "cancelled");
        assert.strictEqual(readEdit(root), before);
        scenario.job = Effect.void;
        assert.strictEqual((yield* silences.removeSilences({ projectId })).cuts, 4);
        assert.strictEqual(scenario.jobs.length, 2);
      }),
    ),
  );

  it.effect("refuses a clip without sound before any job", () =>
    withProject(
      ({ projectId, scenario, silences }) =>
        Effect.gen(function* () {
          scenario.levelsCached = false;
          const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
          assert.strictEqual(error.message, "cam has no sound to find pauses in.");
          assert.deepEqual(scenario.jobs, []);
        }),
      [{ _tag: "putMedia", media: { ...camera, probe: { ...camera.probe, hasAudio: false } } }],
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
        assert.deepEqual(scenario.jobs, []);
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

  describe("after manual moves (S7V-078)", () => {
    /** The whole clip on V1, split at 60 (in speech) and 150 (in speech) into v1, p2 and p3. */
    const splitInThree: ReadonlyArray<EditOp> = [
      { _tag: "putMedia", media: camera },
      { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
      {
        _tag: "setKeepRanges",
        trackId: "V1",
        mediaId: "cam",
        ranges: [{ in: 0, duration: FRAMES }],
      },
      { _tag: "splitItem", itemId: "v1", atFrame: 60, newItemId: "p2" },
      { _tag: "splitItem", itemId: "p2", atFrame: 150, newItemId: "p3" },
      { _tag: "setItemProps", itemId: "p2", props: { label: "middle" } },
      { _tag: "setItemProps", itemId: "p3", props: { gainDb: -3 } },
    ];
    /** The third piece first, a 30-frame gap, then the first and second pieces. */
    const thirdFirst: ReadonlyArray<EditOp> = [
      ...splitInThree,
      { _tag: "moveItem", itemId: "v1", start: 180 },
      { _tag: "moveItem", itemId: "p2", start: 240 },
      { _tag: "moveItem", itemId: "p3", start: 0 },
    ];
    const layout = (document: EditDocument, trackId = "V1") =>
      document.tracks
        .find((track) => track.id === trackId)!
        .items.map((item) => ({
          id: item.id,
          start: item.start,
          in: "in" in item ? item.in : -1,
          duration: item.duration,
          ...("gainDb" in item ? { gainDb: item.gainDb } : {}),
          ...("label" in item ? { label: item.label } : {}),
        }));

    it.effect("removes silences after a move and keeps order, gaps and ids", () =>
      withProject(
        ({ projectId, edits, silences }) =>
          Effect.gen(function* () {
            const result = yield* silences.removeSilences({ projectId });
            // The same frames go as on the unmoved clip (the first test): 3.4 s in 4 cuts.
            assert.strictEqual(result.removedSeconds, 3.4);
            assert.strictEqual(result.cuts, 4);
            assert.strictEqual(result.keptSegments, 5);
            assert.strictEqual(result.shortestSegmentFrames, 33);
            assert.strictEqual(
              result.message,
              "Removed 3.4 s in 4 cuts. This only cuts more; it never restores earlier cuts.",
            );
            const after = yield* edits.read(projectId);
            // Keeps [27,93), [117,183) and [207,273), cut where each piece sits: p3 first, the
            // 30-frame gap, then v1's and p2's parts. A piece whose first frames play keeps its id
            // there (p3, p2); v1 starts in a pause, so its first kept part is a split part.
            assert.deepEqual(layout(after.document), [
              { id: "p3", start: 0, in: 150, duration: 33, gainDb: -3 },
              { id: "vt2", start: 33, in: 207, duration: 66, gainDb: -3 },
              { id: "vt4", start: 129, in: 27, duration: 33 },
              { id: "p2", start: 162, in: 60, duration: 33, label: "middle" },
              { id: "vt5", start: 195, in: 117, duration: 33, label: "middle" },
            ]);
          }),
        thirdFirst,
      ),
    );

    it.effect("in-order clip still uses setKeepRanges, byte for byte", () =>
      withProject(
        ({ projectId, root, edits, silences }) =>
          Effect.gen(function* () {
            const start = yield* edits.read(projectId);
            const result = yield* silences.removeSilences({ projectId });
            assert.isTrue(result.changed);
            const afterCut = readEdit(root);
            const kept = (yield* edits.read(projectId)).document.tracks[0]!.items;
            // The same cut as the setKeepRanges today's service sends gives the same bytes.
            yield* edits.undo(projectId);
            const undone = yield* edits.read(projectId);
            yield* edits.apply(
              projectId,
              [
                {
                  _tag: "setKeepRanges",
                  trackId: "V1",
                  mediaId: "cam",
                  ranges: kept.map((item) => ({
                    in: "in" in item ? item.in! : -1,
                    duration: item.duration,
                  })),
                  start: 0,
                },
              ],
              { origin: "agent", baseRevision: undone.revision },
            );
            assert.strictEqual(readEdit(root), afterCut);
            // Re-laid, as before: three pieces reusing the freed ids, no split ids.
            assert.deepEqual(
              kept.map((item) => item.id),
              ["v1", "v2", "v3"],
            );
            assert.strictEqual(start.document.tracks[0]!.items.length, 3);
          }),
        // Split in three but never moved: still in source order, end to end.
        splitInThree,
      ),
    );

    it.effect("move then cut is one version and one undo", () =>
      withProject(
        ({ projectId, root, edits, silences }) =>
          Effect.gen(function* () {
            const before = readEdit(root);
            const start = yield* edits.read(projectId);
            const versions = yield* edits.versions(projectId);
            const result = yield* silences.removeSilences({ projectId });
            assert.strictEqual(result.revision, start.revision + 1);
            const now = yield* edits.versions(projectId);
            assert.strictEqual(now.length, versions.length + 1);
            assert.deepEqual(now[0]!.changes, ["Removed 3.4 s of silence in 4 cuts"]);
            yield* edits.undo(projectId);
            assert.strictEqual(readEdit(root), before);
          }),
        thirdFirst,
      ),
    );

    it.effect("a piece wholly silent is deleted with ripple", () =>
      withProject(
        ({ projectId, edits, silences }) =>
          Effect.gen(function* () {
            yield* silences.removeSilences({ projectId });
            const after = yield* edits.read(projectId);
            // The silent lead-in [0,25) sat last, after a 20-frame gap: it goes, and nothing else moves.
            assert.deepEqual(layout(after.document), [
              { id: "vt6", start: 0, in: 27, duration: 66 },
              { id: "vt4", start: 66, in: 117, duration: 66 },
              { id: "vt2", start: 132, in: 207, duration: 66 },
            ]);
          }),
        [
          ...splitInThree.slice(0, 3),
          { _tag: "splitItem", itemId: "v1", atFrame: 25, newItemId: "p2" },
          { _tag: "moveItem", itemId: "p2", start: 0 },
          { _tag: "moveItem", itemId: "v1", start: 295 },
        ],
      ),
    );

    it.effect("the same source used twice out of order: both pieces cut in place", () =>
      withProject(
        ({ projectId, edits, silences }) =>
          Effect.gen(function* () {
            const result = yield* silences.removeSilences({ projectId });
            const after = yield* edits.read(projectId);
            assert.deepEqual(layout(after.document), [
              { id: "vt2", start: 0, in: 117, duration: 66 },
              { id: "vt8", start: 96, in: 27, duration: 66 },
              { id: "vt6", start: 162, in: 117, duration: 66 },
              { id: "vt4", start: 228, in: 207, duration: 66 },
            ]);
            // The timeline lost 34 frames from the copy and 102 from the whole clip.
            assert.strictEqual(result.removedSeconds, 4.5);
            assert.strictEqual(result.cuts, 6);
            assert.strictEqual(result.keptSegments, 4);
          }),
        [
          { _tag: "putMedia", media: camera },
          { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
          {
            _tag: "setKeepRanges",
            trackId: "V1",
            mediaId: "cam",
            ranges: [{ in: 100, duration: 100 }],
          },
          {
            _tag: "insertItem",
            trackId: "V1",
            item: { media: "cam", start: 130, duration: FRAMES, in: 0 },
          } as EditOp,
        ],
      ),
    );

    it.effect("a tighter second pass after a move only cuts more", () =>
      withProject(
        ({ projectId, root, scenario, edits, silences }) =>
          Effect.gen(function* () {
            // A third of a second inside the first phrase: kept at 0.4 s, cut at 0.25 s.
            scenario.words = [[30, 55], [65, 90], ...PHRASES.slice(1)];
            const plays = (document: EditDocument) => {
              const frames = new Set<number>();
              for (const item of document.tracks[0]!.items) {
                for (let at = 0; at < item.duration; at++)
                  frames.add(("in" in item ? item.in! : 0) + at);
              }
              return frames;
            };
            yield* silences.removeSilences({ projectId });
            const first = (yield* edits.read(projectId)).document;
            const tighter = yield* silences.removeSilences({ projectId, minGapSeconds: 0.25 });
            assert.isTrue(tighter.changed);
            // The new pause (around frame 60) straddles the split at 60, and those two pieces sit
            // apart on the timeline: two places are cut.
            assert.strictEqual(tighter.cuts, 2);
            const second = (yield* edits.read(projectId)).document;
            const before = plays(first);
            for (const frame of plays(second)) assert.isTrue(before.has(frame), `${frame}`);
            assert.isFalse(plays(second).has(60));
            // Still the user's order: the third piece's parts come first.
            assert.strictEqual(layout(second)[0]!.id, "p3");
            const ids = layout(second).map((item) => item.id);
            assert.strictEqual(new Set(ids).size, ids.length);
            const afterTighter = readEdit(root);
            const again = yield* silences.removeSilences({ projectId, minGapSeconds: 0.25 });
            assert.isFalse(again.changed);
            assert.strictEqual(readEdit(root), afterTighter);
          }),
        thirdFirst,
      ),
    );

    it.effect("another clip after the cut clip closes up", () =>
      withProject(
        ({ projectId, edits, silences }) =>
          Effect.gen(function* () {
            yield* silences.removeSilences({ projectId, media: "cam" });
            const after = yield* edits.read(projectId);
            // 102 frames removed before it: the other clip moves from 360 to 258.
            assert.deepEqual(layout(after.document).at(-1), {
              id: "v2",
              start: 258,
              in: 0,
              duration: 40,
            });
          }),
        [
          ...thirdFirst.slice(0, 1),
          { _tag: "putMedia", media: { ...camera, id: "other", path: "assets/other.mp4" } },
          ...thirdFirst.slice(1, 3),
          {
            _tag: "insertItem",
            trackId: "V1",
            item: { media: "other", start: 360, duration: 40, in: 0 },
          } as EditOp,
          ...thirdFirst.slice(3),
        ],
      ),
    );

    it.effect("linked audio after a move is still refused", () =>
      withProject(
        ({ projectId, root, silences }) =>
          Effect.gen(function* () {
            const before = readEdit(root);
            const error = yield* silences.removeSilences({ projectId }).pipe(Effect.flip);
            assert.strictEqual(error._tag === "SilenceCutError" && error.reason, "linked-audio");
            assert.strictEqual(
              error.message,
              "cam has linked sound on another track; silence removal cannot cut it yet.",
            );
            assert.strictEqual(readEdit(root), before);
          }),
        [
          ...thirdFirst,
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
