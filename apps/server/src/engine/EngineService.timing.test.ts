// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off - makes a synthetic clip with FFmpeg and prints timings for the ticket.
// Timing checks for S7V-022 AC-2 and AC-3, run by hand on a Mac:
//   S7VIDEO_ENGINE_TIMING=1 [S7VIDEO_TIMING_CLIP=/abs/clip.mp4] vp test run src/engine/EngineService.timing.test.ts
// Without a clip it generates a 1080p30 testsrc2 clip in a temp folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";

import * as ServerConfig from "../config.ts";
import * as EngineService from "./EngineService.ts";

const ENABLED = process.env.S7VIDEO_ENGINE_TIMING === "1";

const layer = EngineService.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "engine-timing-" })),
  Layer.provideMerge(NodeServices.layer),
);

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const value = yield* effect;
    return { value, ms: Number((yield* Clock.currentTimeNanos) - start) / 1e6 };
  });

describe.runIf(ENABLED)("EngineService timing", () => {
  it.live("AC-2: warm start under 100 ms median over 10 starts", () =>
    Effect.gen(function* () {
      const startups: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const startup = yield* Effect.gen(function* () {
          const engine = yield* EngineService.EngineService;
          yield* engine.ping;
          return (yield* engine.status).lastStartupMs ?? Number.NaN;
        }).pipe(Effect.provide(layer));
        startups.push(startup);
      }
      console.log(`engine warm start ms: ${startups.join(", ")}; median ${median(startups)}`);
      expect(median(startups)).toBeLessThan(100);
    }),
  );

  it.live("AC-3: probe and frame under 200 ms median over 20 calls", () =>
    Effect.gen(function* () {
      const engine = yield* EngineService.EngineService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-timing-" });
      let clip = process.env.S7VIDEO_TIMING_CLIP;
      if (!clip) {
        clip = path.join(directory, "testsrc2-1080p30.mp4");
        const source = "testsrc2=s=1920x1080:r=30:d=60";
        NodeChildProcess.execFileSync(
          process.env.S7VIDEO_FFMPEG ?? "/opt/homebrew/bin/ffmpeg",
          `-v error -f lavfi -i ${source} -c:v libx264 -pix_fmt yuv420p -g 60`
            .split(" ")
            .concat(clip),
        );
      }
      yield* engine.ping;
      const probe = yield* engine.probe({ path: clip });
      const rate = probe.video?.frameRate ?? { num: 30, den: 1 };
      const frames = probe.durationFrames ?? 1;
      const probes: number[] = [];
      const grabs: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        probes.push((yield* timed(engine.probe({ path: clip }))).ms);
        // Distinct frames across the clip, so no call is served from the PNG cache.
        const frame = Math.floor(((index + 0.5) / 20) * (frames - 1));
        grabs.push((yield* timed(engine.frame({ path: clip, frame, rate }))).ms);
      }
      const round = (values: number[]) => values.map((value) => value.toFixed(0)).join(", ");
      console.log(
        `clip ${path.basename(clip)} ${probe.video?.width}x${probe.video?.height} ${frames} frames`,
      );
      console.log(`probe ms: ${round(probes)}; median ${median(probes).toFixed(1)}`);
      console.log(`frame ms: ${round(grabs)}; median ${median(grabs).toFixed(1)}`);
      expect(median(probes)).toBeLessThan(200);
      expect(median(grabs)).toBeLessThan(200);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
