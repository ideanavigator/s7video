// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off -- Reads the cached clip and fixtures, prints the result for the ticket.
/**
 * Golden `silence-cut-talking-head` (S7V-027): talking-head-01 through the real service and engine;
 * cut list exact vs the reference, ±1 frame vs keep.json, no clipped word. The first rate's levels
 * come from a `silence` job, the rest from the file it wrote (S7V-055). `S7VIDEO_GOLDEN_UPDATE=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type EditDocument,
  type EditRational,
  SilenceLevels,
  Transcript,
  validateEditDocument,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
const REFERENCE = NodePath.join(
  REPO,
  "packages/engine/tests/golden/references/silence-cut-talking-head.json",
);
const KEEP = NodePath.join(REPO, "fixtures/media/talking-head-01.keep.json");
const TRANSCRIPT = NodePath.join(REPO, "fixtures/media/talking-head-01.transcript.json");
const CLIP = NodePath.join(
  process.env.S7VIDEO_TEST_MEDIA_DIR ??
    NodePath.join(NodeOS.homedir(), "Library/Caches/s7video-test-media"),
  "talking-head-01.webm",
);
const UPDATE = process.env.S7VIDEO_GOLDEN_UPDATE === "1";
const available =
  NodeFS.existsSync(CLIP) &&
  ["uv", "ffmpeg", "ffprobe"].every((name) =>
    ["/opt/homebrew/bin", "/usr/local/bin"].some((folder) =>
      NodeFS.existsSync(`${folder}/${name}`),
    ),
  );

const RATES: ReadonlyArray<EditRational> = [
  { num: 24000, den: 1001 },
  { num: 30000, den: 1001 },
  { num: 25, den: 1 },
];
const rateKey = (rate: EditRational) => `${rate.num}/${rate.den}`;
const CALL_LIMIT_MS = 2000;

type Span = readonly [number, number];
interface RateResult {
  readonly mediaFrames: number;
  readonly ranges: ReadonlyArray<Span>;
  readonly cuts: number;
  readonly removedSeconds: number;
}

const decodeTranscript = Schema.decodeUnknownSync(Schema.fromJsonString(Transcript));
const transcript = () => decodeTranscript(NodeFS.readFileSync(TRANSCRIPT, "utf8"));
const decodeLevels = Schema.decodeUnknownSync(Schema.fromJsonString(SilenceLevels));

/** One project at `fps` with the clip recorded by reference, cut with the defaults twice. */
const cutAt = (fps: EditRational) =>
  Effect.gen(function* () {
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const edits = yield* EditDocumentService.EditDocumentService;
    const engine = yield* EngineService.EngineService;
    const silences = yield* SilenceCutService.SilenceCutService;
    const created = yield* folders.createNamedProject({ name: `Silence ${fps.num}` });
    const probe = yield* engine.probe({ path: CLIP });
    const document: EditDocument = {
      version: 1,
      fps,
      canvas: { width: 1080, height: 1920 },
      media: [
        {
          id: "cam",
          kind: "video",
          reference: CLIP,
          fingerprint: transcript().mediaFingerprint,
          probe: toEditProbe(probe, fps),
        },
      ],
      tracks: [],
      markers: [],
      metadata: {},
    };
    // Written as the user's own edit, which the service records on its next read.
    const editFile = NodePath.join(created.workspaceRoot, EditProjectLayout.EDIT_FILE);
    NodeFS.writeFileSync(editFile, EditProjectLayout.editFileContents(document));

    const started = yield* Clock.currentTimeMillis;
    const result = yield* silences.removeSilences({ projectId: created.projectId });
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    const afterCut = NodeFS.readFileSync(editFile, "utf8");
    const again = yield* silences.removeSilences({ projectId: created.projectId });
    const snapshot = yield* edits.read(created.projectId);
    return {
      result,
      again,
      elapsed,
      repeatedBytes: NodeFS.readFileSync(editFile, "utf8") === afterCut,
      document: snapshot.document,
      mediaFrames: document.media[0]!.probe.durationFrames!,
    };
  });

const keptSpans = (document: EditDocument): Span[] =>
  document.tracks.flatMap((track) =>
    track.kind === "video"
      ? track.items.map((item): Span => [item.in, item.in + item.duration])
      : [],
  );

/** A source frame at `from` as an exact time, compared in document frames at `to`. */
const scale = (frame: number, from: EditRational, to: EditRational) =>
  (frame * to.num * from.den) / (to.den * from.num);

describe.skipIf(!available)("silence-cut-talking-head golden", () => {
  it.live("cuts talking-head-01's pauses at three frame rates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-silence-golden-" });
      const words = transcript();
      const cacheDir = NodePath.join(baseDir, "transcripts");
      const levelsFile = NodePath.join(cacheDir, `${words.mediaFingerprint.sha256}.levels.json`);
      const sources: string[] = [];
      const services = SilenceCutService.layer.pipe(
        Layer.provideMerge(
          Layer.mock(TranscriptService.TranscriptService)({
            levels: (input) =>
              Effect.sync(() => {
                const cached = NodeFS.existsSync(levelsFile)
                  ? decodeLevels(NodeFS.readFileSync(levelsFile, "utf8"))
                  : null;
                sources.push(cached === null ? "job" : "file");
                return {
                  transcript: words,
                  cached,
                  measure: {
                    projectId: input.projectId,
                    path: CLIP,
                    cacheDir,
                    fingerprint: words.mediaFingerprint,
                  },
                };
              }),
          }),
        ),
        Layer.provideMerge(EngineService.layer),
        Layer.provideMerge(layerEditTest(baseDir)),
      );
      const observed: Record<string, RateResult> = {};
      for (const fps of RATES) {
        const run = yield* cutAt(fps).pipe(Effect.provide(services));
        const ranges = keptSpans(run.document);
        console.log(
          `silence-cut-talking-head ${rateKey(fps)}: ${run.result.cuts} cuts, ${run.result.removedSeconds} s removed, ${ranges.length} keeps, shortest ${run.result.shortestSegmentFrames} frames, ${run.elapsed} ms`,
        );

        // AC-9: the summary matches the edit, within the time limit.
        const kept = ranges.reduce((sum, [from, to]) => sum + to - from, 0);
        const removed = ((run.mediaFrames - kept) * fps.den) / fps.num;
        expect(Math.abs(run.result.removedSeconds - removed)).toBeLessThanOrEqual(0.05);
        expect(run.result.keptSegments).toBe(ranges.length);
        expect(run.elapsed).toBeLessThan(CALL_LIMIT_MS);
        // AC-8: a repeat changes nothing.
        expect(run.again.changed).toBe(false);
        expect(run.again.revision).toBe(run.result.revision);
        expect(run.repeatedBytes).toBe(true);
        // AC-5: integer frames that the validator accepts.
        expect(validateEditDocument(run.document).ok).toBe(true);
        for (const [from, to] of ranges) {
          expect(Number.isInteger(from) && Number.isInteger(to)).toBe(true);
          // AC-4: no keep under 0.3 s.
          expect(((to - from) * fps.den) / fps.num).toBeGreaterThanOrEqual(0.3);
        }
        // AC-2 and AC-3: every word is kept whole, with its air unless the next word is closer.
        const air = Math.round((0.1 * words.fps.num) / words.fps.den);
        words.words.forEach((word, index) => {
          const start = scale(word.startFrame, words.fps, fps);
          const end = scale(word.endFrame, words.fps, fps);
          const holder = ranges.find(([from, to]) => from <= start && to >= end);
          expect(holder, `${word.text} at ${word.startFrame}`).toBeDefined();
          const before = Math.min(air, word.startFrame - (words.words[index - 1]?.endFrame ?? 0));
          const after = Math.min(
            air,
            (words.words[index + 1]?.startFrame ?? words.durationFrames) - word.endFrame,
          );
          expect(start - holder![0]).toBeGreaterThanOrEqual(scale(before, words.fps, fps));
          expect(Math.min(holder![1], run.mediaFrames) - end).toBeGreaterThanOrEqual(
            Math.min(scale(after, words.fps, fps), run.mediaFrames - end),
          );
        });
        observed[rateKey(fps)] = {
          mediaFrames: run.mediaFrames,
          ranges,
          cuts: run.result.cuts,
          removedSeconds: run.result.removedSeconds,
        };
      }

      // AC-2 (S7V-055): one job measured the levels; every later call read its file.
      expect(sources).toEqual(["job", ...Array.from({ length: 5 }, () => "file")]);
      const file = decodeLevels(NodeFS.readFileSync(levelsFile, "utf8"));
      expect(file.fps).toEqual(words.fps);
      expect(file.durationFrames).toBe(words.durationFrames);

      if (UPDATE) {
        NodeFS.writeFileSync(
          REFERENCE,
          `${JSON.stringify({ clip: "talking-head-01", rates: observed }, null, 1)}\n`,
        );
      }
      const reference = JSON.parse(NodeFS.readFileSync(REFERENCE, "utf8")) as {
        readonly rates: Record<string, RateResult>;
      };
      // AC-1: the cut list equals the stored reference exactly at every rate.
      expect(observed).toEqual(reference.rates);

      // AC-1: each boundary within ±1 frame of the separately made keep ranges.
      const hand = (JSON.parse(NodeFS.readFileSync(KEEP, "utf8")) as { keep: Span[] }).keep;
      const native = observed[rateKey(RATES[0]!)]!.ranges;
      expect(native.length).toBe(hand.length);
      native.forEach(([from, to], index) => {
        expect(Math.abs(from - hand[index]![0]), `keep ${index} start`).toBeLessThanOrEqual(1);
        expect(Math.abs(to - hand[index]![1]), `keep ${index} end`).toBeLessThanOrEqual(1);
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
