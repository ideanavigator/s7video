// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off - samples the engine's memory with ps and prints timings for the ticket.
// S7V-026 measurements through the real EngineService and engine process, run by hand on a Mac:
//   S7VIDEO_TEST_MODELS_DIR=/abs/models [S7VIDEO_TIMING_CLIP=/abs/clip] \
//     vp test run src/transcript/TranscriptService.timing.test.ts
// The models folder is an HF_HOME where the engine's download has run (never the app's own data
// folder). The clip defaults to talking-head-01 in the test-media cache (`pnpm media:fetch`).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type EditSnapshot, ProjectId, type TranscribeModel } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EditDocumentService from "../edit/EditDocumentService.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TranscriptService from "./TranscriptService.ts";

const MODELS = process.env.S7VIDEO_TEST_MODELS_DIR ?? "";
const CLIP =
  process.env.S7VIDEO_TIMING_CLIP ??
  NodePath.join(NodeOS.homedir(), "Library/Caches/s7video-test-media/talking-head-01.webm");
const ENABLED = MODELS !== "" && NodeFS.existsSync(CLIP);

/** Each run gets a fresh project folder, so the transcript cache never answers. */
const project = { root: "" };
const projectId = ProjectId.make("project-timing");

// The clip stays where it is: the edit document records it as a reference.
const layerProject = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.sync(() => Option.some({ workspaceRoot: project.root } as never)),
  }),
  Layer.mock(EditDocumentService.EditDocumentService)({
    read: () =>
      Effect.succeed({
        revision: 1,
        document: {
          version: 1,
          fps: { num: 30, den: 1 },
          canvas: { width: 1920, height: 1080 },
          media: [
            {
              id: "clip",
              kind: "video",
              reference: CLIP,
              fingerprint: { sha256: "ab".repeat(32), size: 1 },
              probe: { hasVideo: true, hasAudio: true },
            },
          ],
          tracks: [],
          markers: [],
          metadata: {},
        },
        canUndo: false,
        canRedo: false,
      } satisfies EditSnapshot),
  }),
);

const layerWith = (idleUnloadMinutes: number) =>
  TranscriptService.layer.pipe(
    Layer.provide(layerProject),
    Layer.provideMerge(EngineService.layerWith({ transcribeIdleUnloadMinutes: idleUnloadMinutes })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "transcribe-timing-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/** Points the test server's models folder at the prepared one, before the engine starts. */
const useModels = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  NodeFS.rmSync(config.engineModelsDir, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.dirname(config.engineModelsDir), { recursive: true });
  NodeFS.symlinkSync(MODELS, config.engineModelsDir);
});

const rssBytes = (pid: number) => {
  try {
    return (
      Number(NodeChildProcess.execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)])) * 1024
    );
  } catch {
    return 0;
  }
};

const freshProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  project.root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "transcribe-project-" });
  return { projectId, media: "clip" };
});

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const value = yield* effect;
    return { value, ms: Number((yield* Clock.currentTimeNanos) - start) / 1e6 };
  });

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

describe.runIf(ENABLED)("TranscriptService timing (S7V-026)", () => {
  it.live("AC-4 and AC-8: warm time and peak memory per model, then the cache", () =>
    Effect.gen(function* () {
      yield* useModels;
      const engine = yield* EngineService.EngineService;
      const service = yield* TranscriptService.TranscriptService;
      const pid = (yield* engine.ping).pid;
      const idleRss = rssBytes(pid);
      for (const model of ["default", "light"] as const satisfies ReadonlyArray<TranscribeModel>) {
        const first = yield* timed(service.transcribe({ ...(yield* freshProject), model }));
        // Sampled on each progress event (once per chunk), while the model is busy.
        let peakRss = 0;
        const sampler = yield* engine.subscribeJobs.pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              peakRss = Math.max(peakRss, rssBytes(pid));
            }),
          ),
          Effect.forkChild,
        );
        const warm = yield* timed(service.transcribe({ ...(yield* freshProject), model }));
        yield* Fiber.interrupt(sampler);
        console.log(
          `${model}: first ${first.ms.toFixed(0)} ms (load ${first.value.timings?.loadMs} ms), ` +
            `warm ${warm.ms.toFixed(0)} ms, ${warm.value.wordCount} words, ` +
            `peak RSS ${gb(peakRss)}, MLX peak ${gb(warm.value.timings?.peakMemoryBytes ?? 0)}, ` +
            `engine idle RSS ${gb(idleRss)}`,
        );
        expect(warm.ms).toBeLessThan(30_000);
      }
      const clip = yield* freshProject;
      yield* service.transcribe(clip);
      const cached = yield* timed(service.transcribe(clip));
      console.log(`cache hit: ${cached.ms.toFixed(0)} ms`);
      expect(cached.value.cached).toBe(true);
      expect(cached.ms).toBeLessThan(1_000);
    }).pipe(Effect.scoped, Effect.provide(layerWith(10))),
  );

  it.live("ADR-004: frame latency while a transcription runs", () =>
    Effect.gen(function* () {
      yield* useModels;
      const engine = yield* EngineService.EngineService;
      const service = yield* TranscriptService.TranscriptService;
      const probe = yield* engine.probe({ path: CLIP });
      const rate = probe.video?.frameRate ?? { num: 30, den: 1 };
      const frames = probe.durationFrames ?? 100;
      let next = 0;
      const grab = () => {
        next += 1;
        const frame = Math.floor((((next * 37) % 97) / 97) * (frames - 1));
        return timed(engine.frame({ path: CLIP, frame, rate })).pipe(Effect.map(({ ms }) => ms));
      };
      const idle: number[] = [];
      for (let index = 0; index < 15; index += 1) idle.push(yield* grab());
      // Load the model first so the measured run is pure transcription.
      yield* service.transcribe({ ...(yield* freshProject), model: "default" });
      const transcribing = yield* engine.subscribeJobs.pipe(
        Stream.filter((event) => event.type === "updated" && event.job.stage === "transcribing"),
        Stream.runHead,
        Effect.forkChild,
      );
      const running = yield* service
        .transcribe({ ...(yield* freshProject), model: "default" })
        .pipe(Effect.forkChild);
      yield* Fiber.join(transcribing);
      const busy: number[] = [];
      while (running.pollUnsafe() === undefined) busy.push(yield* grab());
      yield* Fiber.join(running);
      console.log(
        `frame ms idle median ${median(idle).toFixed(0)} (max ${Math.max(...idle).toFixed(0)}); ` +
          `during transcription median ${median(busy).toFixed(0)} ` +
          `(max ${Math.max(...busy).toFixed(0)}, ${busy.length} frames)`,
      );
      expect(busy.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(layerWith(10))),
  );

  it.live("AC-10: the model unloads after the idle timeout", () =>
    Effect.gen(function* () {
      yield* useModels;
      const engine = yield* EngineService.EngineService;
      const service = yield* TranscriptService.TranscriptService;
      const pid = (yield* engine.ping).pid;
      const before = rssBytes(pid);
      yield* service.transcribe({ ...(yield* freshProject), model: "default" });
      const loaded = rssBytes(pid);
      expect((yield* service.modelsStatus).loadedProfile).toBe("default");
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- measures the engine's own 6 s idle timer in another process; no event marks the unload.
      yield* Effect.sleep("8 seconds");
      const after = rssBytes(pid);
      console.log(
        `engine RSS: idle ${gb(before)}, model loaded ${gb(loaded)}, after unload ${gb(after)}`,
      );
      expect((yield* service.modelsStatus).loadedProfile).toBeNull();
      expect(after).toBeLessThan(before + (loaded - before) / 4);
    }).pipe(Effect.scoped, Effect.provide(layerWith(0.1))),
  );
});
