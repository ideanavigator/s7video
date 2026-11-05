// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - builds media files and hashes them independently.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EngineError,
  type TranscribeEngineModelsStatus,
  type Transcript,
  type TranscriptWord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as EngineService from "../engine/EngineService.ts";
import { mediaFingerprint } from "./mediaFingerprint.ts";
import * as TranscriptService from "./TranscriptService.ts";

const GB = 1024 ** 3;

const engineStatus = (ready: {
  default: boolean;
  light: boolean;
}): TranscribeEngineModelsStatus => ({
  models: {
    "asr-1.7b": {
      repo: "a",
      revision: "r",
      sizeBytes: 300,
      downloadedBytes: 120,
      ready: ready.default,
    },
    "asr-0.6b": {
      repo: "b",
      revision: "r",
      sizeBytes: 100,
      downloadedBytes: 0,
      ready: ready.light,
    },
    "aligner-0.6b": { repo: "c", revision: "r", sizeBytes: 50, downloadedBytes: 50, ready: true },
  },
  profiles: {
    default: { models: ["asr-1.7b", "aligner-0.6b"], sizeBytes: 350, ready: ready.default },
    light: { models: ["asr-0.6b", "aligner-0.6b"], sizeBytes: 150, ready: ready.light },
  },
  loadedProfile: null,
});

interface Calls {
  readonly jobs: Array<{ kind: string; method: string; params: Readonly<Record<string, unknown>> }>;
}

const setup = (options: {
  readonly totalMemoryBytes: number;
  readonly ready?: { default: boolean; light: boolean };
  readonly jobError?: EngineError;
}) => {
  const calls: Calls = { jobs: [] };
  const engine = Layer.mock(EngineService.EngineService)({
    call: (method) =>
      method === "transcribe.models.status"
        ? Effect.succeed(engineStatus(options.ready ?? { default: false, light: false }) as never)
        : Effect.die(`unexpected ${method}`),
    runJob: (input) =>
      Effect.suspend(() => {
        calls.jobs.push({ kind: input.kind, method: input.method, params: input.params });
        if (options.jobError) return Effect.fail(options.jobError);
        return Effect.succeed(
          (input.method === "transcribe.run"
            ? {
                path: "/x.json",
                cached: false,
                model: "m",
                fps: { num: 30, den: 1 },
                wordCount: 0,
                durationFrames: 0,
              }
            : { profile: input.params.model, ready: true, sizeBytes: 1 }) as never,
        );
      }),
  });
  const layer = TranscriptService.layerWith({ totalMemoryBytes: options.totalMemoryBytes }).pipe(
    Layer.provide(engine),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "transcript-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, layer };
};

const word = (text: string, startFrame: number, endFrame: number): TranscriptWord => ({
  text,
  startFrame,
  endFrame,
  confidence: 0.9,
  speaker: "S1",
});

const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "transcript-project-" });
  yield* fileSystem.makeDirectory(path.join(root, "assets"));
  const clip = path.join(root, "assets", "clip.webm");
  yield* fileSystem.writeFile(clip, new Uint8Array([1, 2, 3, 4, 5]));
  const fingerprint = yield* mediaFingerprint(clip);
  const cacheDir = path.join(root, ".s7cache", "transcripts");
  yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
  return { root, clip, fingerprint, cacheDir, fileSystem, path };
});

describe("TranscriptService", () => {
  it.effect("TranscriptService preselects light model at 8 GB", () => {
    const small = setup({ totalMemoryBytes: 8 * GB });
    const large = setup({ totalMemoryBytes: 36 * GB });
    return Effect.gen(function* () {
      const onSmall = yield* TranscriptService.TranscriptService.pipe(
        Effect.flatMap((service) => service.modelsStatus),
        Effect.provide(small.layer),
      );
      expect(onSmall.recommended).toBe("light");
      expect(onSmall.consent).toBe("unasked");
      // Partial bytes add up per profile (the shared aligner counts in both).
      expect(onSmall.profiles.default).toEqual({
        sizeBytes: 350,
        downloadedBytes: 170,
        ready: false,
      });
      expect(onSmall.profiles.light).toEqual({ sizeBytes: 150, downloadedBytes: 50, ready: false });
      const onLarge = yield* TranscriptService.TranscriptService.pipe(
        Effect.flatMap((service) => service.modelsStatus),
        Effect.provide(large.layer),
      );
      expect(onLarge.recommended).toBe("default");
    });
  });

  it.effect("asks once: a download or a dismissal is remembered", () => {
    const { layer, calls } = setup({ totalMemoryBytes: 8 * GB });
    return Effect.gen(function* () {
      const service = yield* TranscriptService.TranscriptService;
      expect((yield* service.dismissDownload).consent).toBe("dismissed");
      expect((yield* service.modelsStatus).consent).toBe("dismissed");
      const result = yield* service.downloadModels("light");
      expect(result).toEqual({ profile: "light", ready: true, sizeBytes: 1 });
      expect(calls.jobs).toEqual([
        {
          kind: "transcribe.models.download",
          method: "transcribe.models.download",
          params: { model: "light" },
        },
      ]);
      expect((yield* service.modelsStatus).consent).toBe("accepted");
    }).pipe(Effect.provide(layer));
  });

  it.effect("transcribes with the model already downloaded, into the project's cache", () => {
    const { layer, calls } = setup({
      totalMemoryBytes: 36 * GB,
      ready: { default: false, light: true },
    });
    return Effect.gen(function* () {
      const project = yield* makeProject;
      const service = yield* TranscriptService.TranscriptService;
      yield* service.transcribe({ projectRoot: project.root, mediaPath: "assets/clip.webm" });
      expect(calls.jobs[0]).toEqual({
        kind: "transcribe",
        method: "transcribe.run",
        params: {
          path: project.clip,
          cacheDir: project.cacheDir,
          fingerprint: project.fingerprint,
          model: "light",
        },
      });
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("passes a missing model to the caller as models_missing", () => {
    const { layer } = setup({
      totalMemoryBytes: 36 * GB,
      jobError: new EngineError({ reason: "models_missing", method: "transcribe.run" }),
    });
    return Effect.gen(function* () {
      const project = yield* makeProject;
      const service = yield* TranscriptService.TranscriptService;
      const error = yield* service
        .transcribe({ projectRoot: project.root, mediaPath: project.clip })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "EngineError", reason: "models_missing" });
      expect(error.message).toContain("accept the download in the Editor panel");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("reads the cached transcript and packs it as short frame-stamped lines", () => {
    const { layer } = setup({ totalMemoryBytes: 36 * GB });
    return Effect.gen(function* () {
      const project = yield* makeProject;
      const service = yield* TranscriptService.TranscriptService;
      const input = { projectRoot: project.root, mediaPath: "assets/clip.webm" };
      expect(yield* service.get(input)).toBeNull();
      expect(yield* service.readText(input)).toBeNull();
      const transcript: Transcript = {
        transcriptVersion: 1,
        mediaFingerprint: project.fingerprint,
        model: "mlx-community/Qwen3-ASR-1.7B-8bit",
        revision: "r",
        fps: { num: 30, den: 1 },
        durationFrames: 300,
        words: [word("Hello", 10, 20), word("there.", 21, 30), word("Next", 60, 70)],
        createdAt: "2026-11-05T00:00:00Z",
      };
      const file = project.path.join(project.cacheDir, `${project.fingerprint.sha256}.json`);
      yield* project.fileSystem.writeFileString(file, JSON.stringify(transcript));
      expect(yield* service.get(input)).toEqual(transcript);
      expect(yield* service.readText(input)).toBe(
        "fps 30/1; [start-end] are frames of the clip.\n[10-30] Hello there.\n[60-70] Next",
      );
      expect(yield* service.readText({ ...input, fromFrame: 40 })).toBe(
        "fps 30/1; [start-end] are frames of the clip.\n[60-70] Next",
      );
      // A different file under the same name is not this media's transcript.
      yield* project.fileSystem.writeFileString(
        file,
        JSON.stringify({ ...transcript, mediaFingerprint: { ...project.fingerprint, size: 6 } }),
      );
      expect(yield* service.get(input)).toBeNull();
      yield* project.fileSystem.writeFileString(file, "{not json");
      const error = yield* service.get(input).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "TranscriptError", reason: "cache_unreadable" });
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});

describe("mediaFingerprint", () => {
  it.effect("hashes small files whole and large ones by their first and last MiB", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fingerprint-" });
      const small = path.join(dir, "small.bin");
      const smallBytes = new Uint8Array(1000).map((_, index) => index % 251);
      yield* fileSystem.writeFile(small, smallBytes);
      expect(yield* mediaFingerprint(small)).toEqual({
        sha256: NodeCrypto.createHash("sha256").update(smallBytes).digest("hex"),
        size: 1000,
      });
      const mib = 1024 * 1024;
      const big = new Uint8Array(3 * mib + 17).map((_, index) => (index * 7) % 256);
      const bigPath = path.join(dir, "big.bin");
      yield* fileSystem.writeFile(bigPath, big);
      const expected = NodeCrypto.createHash("sha256")
        .update(big.subarray(0, mib))
        .update(big.subarray(big.length - mib))
        .digest("hex");
      expect(yield* mediaFingerprint(bigPath)).toEqual({ sha256: expected, size: big.length });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
