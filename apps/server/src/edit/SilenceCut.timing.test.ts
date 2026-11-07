// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off - makes a long clip with FFmpeg and prints timings for the ticket.
// S7V-055 AC-5, run by hand on a Mac with the real engine:
//   S7VIDEO_MEDIA_TIMING=1 vp test run src/edit/SilenceCut.timing.test.ts
// Makes a 30-minute clip (16x16 black video, a tone two seconds in three, about 9 MB) in a
// scratch folder, removes its silences once with no levels file (the `silence` job measures them)
// and once from the file that job wrote, then deletes the clip.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type EditDocument, SilenceLevels, type Transcript } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EngineService from "../engine/EngineService.ts";
import { toEditProbe } from "../media/MediaLibraryService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { layerEditTest } from "./editHarness.testkit.ts";
import * as SilenceCutService from "./SilenceCutService.ts";

const ENABLED = process.env.S7VIDEO_MEDIA_TIMING === "1";
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((path) =>
  NodeFS.existsSync(path),
);
const SECONDS = 1800;
const CACHED_LIMIT_MS = 2_000;
const decodeLevels = Schema.decodeUnknownSync(Schema.fromJsonString(SilenceLevels));

/** Three words in each two seconds of tone (the tone plays while `t mod 3 < 2`), at 30 fps. */
const transcriptOf = (fingerprint: Transcript["mediaFingerprint"]): Transcript => ({
  transcriptVersion: 1,
  mediaFingerprint: fingerprint,
  model: "timing",
  revision: "timing",
  fps: { num: 30, den: 1 },
  durationFrames: SECONDS * 30,
  words: Array.from({ length: SECONDS / 3 }, (_, block) =>
    [0, 1, 2].map((index) => ({
      text: `w${block}-${index}`,
      startFrame: block * 90 + 3 + index * 19,
      endFrame: block * 90 + 3 + index * 19 + 17,
      confidence: null,
      speaker: "S1",
    })),
  ).flat(),
  createdAt: "2026-11-07T00:00:00.000Z",
});

describe.skipIf(!ENABLED || FFMPEG === undefined)("silence removal on a 30-minute clip", () => {
  it.live(
    "answers from cached levels in under 2 s, and the fallback job hits no quick-call limit",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-silence-30m-" });
        const clip = NodePath.join(baseDir, "long30.mp4");
        const tone = "0.3*sin(2*PI*220*t)*lt(mod(t,3),2)+0.001*(random(0)-0.5)";
        NodeChildProcess.execFileSync(
          FFMPEG!,
          `-v error -y -f lavfi -i color=c=black:s=16x16:r=30:d=${SECONDS} -f lavfi -i aevalsrc='${tone}':s=48000:d=${SECONDS} -c:v mpeg4 -q:v 31 -c:a aac -b:a 32k -shortest`
            .split(" ")
            .concat(clip),
        );
        const fingerprint = { sha256: "5".repeat(64), size: NodeFS.statSync(clip).size };
        const transcript = transcriptOf(fingerprint);
        const cacheDir = NodePath.join(baseDir, "transcripts");
        const levelsFile = NodePath.join(cacheDir, `${fingerprint.sha256}.levels.json`);
        const services = SilenceCutService.layer.pipe(
          Layer.provideMerge(
            Layer.mock(TranscriptService.TranscriptService)({
              // As TranscriptService.levels does: read and decode the file the job wrote.
              levels: (input) =>
                Effect.sync(() => ({
                  transcript,
                  cached: NodeFS.existsSync(levelsFile)
                    ? decodeLevels(NodeFS.readFileSync(levelsFile, "utf8"))
                    : null,
                  measure: { projectId: input.projectId, path: clip, cacheDir, fingerprint },
                })),
            }),
          ),
          Layer.provideMerge(EngineService.layer),
          Layer.provideMerge(layerEditTest(baseDir)),
        );
        yield* Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const edits = yield* EditDocumentService.EditDocumentService;
          const engine = yield* EngineService.EngineService;
          const silences = yield* SilenceCutService.SilenceCutService;
          const created = yield* folders.createNamedProject({ name: "Silence 30 minutes" });
          const fps = { num: 30, den: 1 };
          const document: EditDocument = {
            version: 1,
            fps,
            canvas: { width: 1080, height: 1920 },
            media: [
              {
                id: "talk",
                kind: "video",
                reference: clip,
                fingerprint,
                probe: toEditProbe(yield* engine.probe({ path: clip }), fps),
              },
            ],
            tracks: [],
            markers: [],
            metadata: {},
          };
          // The frame rate is the user's own edit; the clip is imported through the service, since an
          // outside write of a reference is refused (S7V-054).
          NodeFS.writeFileSync(
            NodePath.join(created.workspaceRoot, "edit.json"),
            `${JSON.stringify({ ...document, media: [] }, null, 2)}\n`,
          );
          const opened = yield* edits.read(created.projectId);
          yield* edits.apply(
            created.projectId,
            document.media.map((media) => ({ _tag: "putMedia" as const, media })),
            { origin: "import", baseRevision: opened.revision },
          );
          const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis;
              const value = yield* effect;
              return { value, ms: (yield* Clock.currentTimeMillis) - started };
            });

          // No levels file: a `silence` job measures the whole clip (no 30 s quick-call limit).
          const fallback = yield* timed(silences.removeSilences({ projectId: created.projectId }));
          expect(NodeFS.existsSync(levelsFile)).toBe(true);
          expect(fallback.value.cuts).toBeGreaterThan(500);
          yield* edits.undo(created.projectId);
          // The levels file: the same cut, at once.
          const cached = yield* timed(silences.removeSilences({ projectId: created.projectId }));
          const tighter = yield* timed(
            silences.removeSilences({ projectId: created.projectId, minGapSeconds: 0.25 }),
          );
          console.log(
            `silence 30 min: fallback job ${fallback.ms} ms, cached ${cached.ms} ms, tighter ${tighter.ms} ms, ${cached.value.cuts} cuts, ${cached.value.removedSeconds} s removed`,
          );
          expect(cached.value.cuts).toBe(fallback.value.cuts);
          expect(cached.value.removedSeconds).toBe(fallback.value.removedSeconds);
          expect(cached.ms).toBeLessThan(CACHED_LIMIT_MS);
          expect(tighter.ms).toBeLessThan(CACHED_LIMIT_MS);
        }).pipe(Effect.provide(services));
        NodeFS.rmSync(clip, { force: true });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
