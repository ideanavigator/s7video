// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - builds project folders, symlinks and media files, and hashes them independently.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type EditMedia,
  type EditSnapshot,
  EngineError,
  EngineJobId,
  ProjectId,
  type TranscribeEngineModelsStatus,
  type Transcript,
  type TranscriptWord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as EditDocumentService from "../edit/EditDocumentService.ts";
import * as EngineService from "../engine/EngineService.ts";
import { NOT_IN_PROJECT } from "../mcp/VideoProjectScope.ts";
import * as ProjectService from "../project/ProjectService.ts";
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
    light: {
      models: ["asr-0.6b", "aligner-0.6b"],
      sizeBytes: 150,
      ready: ready.light,
      found: ready.light ? null : { copyBytes: 0 },
    },
  },
  loadedProfile: null,
});

interface Calls {
  readonly jobs: Array<{
    kind: string;
    method: string;
    params: Readonly<Record<string, unknown>>;
    projectId: ProjectId | undefined;
    started: boolean;
  }>;
}

const projectId = ProjectId.make("project-transcribe");
const unknownProject = ProjectId.make("project-unknown");

/** A project with one clip, a file outside it, and a symlink inside that points outside. */
const makeProject = () => {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-tr-")));
  const root = NodePath.join(base, "Project");
  const outside = NodePath.join(base, "Desktop");
  NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
  NodeFS.mkdirSync(outside);
  const clip = NodePath.join(root, "assets", "clip.webm");
  NodeFS.writeFileSync(clip, new Uint8Array([1, 2, 3, 4, 5]));
  NodeFS.writeFileSync(NodePath.join(outside, "secret.webm"), "secret");
  NodeFS.symlinkSync(
    NodePath.join(outside, "secret.webm"),
    NodePath.join(root, "assets", "link.webm"),
  );
  const bytes = NodeFS.readFileSync(clip);
  return {
    base,
    root,
    outside,
    clip,
    cacheDir: NodePath.join(root, ".s7cache", "transcripts"),
    fingerprint: {
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    },
  };
};
type Project = ReturnType<typeof makeProject>;

const recorded = (entry: Partial<EditMedia> & Pick<EditMedia, "id">): EditMedia => ({
  kind: "video",
  fingerprint: { sha256: "ab".repeat(32), size: 1 },
  probe: { hasVideo: true, hasAudio: true },
  ...entry,
});

const setup = (options: {
  readonly totalMemoryBytes: number;
  readonly ready?: { default: boolean; light: boolean };
  readonly jobError?: EngineError;
}) => {
  const calls: Calls = { jobs: [] };
  const project = makeProject();
  const record = (input: EngineService.EngineJobInput<unknown>, started: boolean) =>
    calls.jobs.push({
      kind: input.kind,
      method: input.method,
      params: input.params,
      projectId: input.projectId,
      started,
    });
  const engine = Layer.mock(EngineService.EngineService)({
    call: (method) =>
      method === "transcribe.models.status"
        ? Effect.succeed(engineStatus(options.ready ?? { default: false, light: false }) as never)
        : Effect.die(`unexpected ${method}`),
    runJob: (input) =>
      Effect.suspend(() => {
        record(input, false);
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
    startJob: (input) =>
      Effect.sync(() => {
        record(input, true);
        return EngineJobId.make("engine-job-7");
      }),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeed(
        id === projectId ? Option.some({ workspaceRoot: project.root } as never) : Option.none(),
      ),
  });
  const edits = Layer.mock(EditDocumentService.EditDocumentService)({
    read: () =>
      Effect.succeed({
        revision: 1,
        document: {
          version: 1,
          fps: { num: 30, den: 1 },
          canvas: { width: 1080, height: 1920 },
          media: [
            recorded({ id: "cam", path: "assets/clip.webm" }),
            recorded({ id: "escape", path: "../Desktop/secret.webm" }),
          ],
          tracks: [],
          markers: [],
          metadata: {},
        },
        canUndo: false,
        canRedo: false,
      } satisfies EditSnapshot),
  });
  const layer = TranscriptService.layerWith({ totalMemoryBytes: options.totalMemoryBytes }).pipe(
    Layer.provide(Layer.mergeAll(engine, projects, edits)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "transcript-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, layer, project };
};

const cleanup = (project: Project) =>
  Effect.sync(() => NodeFS.rmSync(project.base, { recursive: true, force: true }));

const word = (text: string, startFrame: number, endFrame: number): TranscriptWord => ({
  text,
  startFrame,
  endFrame,
  confidence: 0.9,
  speaker: "S1",
});

const transcriptFor = (fingerprint: Project["fingerprint"]): Transcript => ({
  transcriptVersion: 1,
  mediaFingerprint: fingerprint,
  model: "mlx-community/Qwen3-ASR-1.7B-8bit",
  revision: "r",
  fps: { num: 30, den: 1 },
  durationFrames: 300,
  words: [word("Hello", 10, 20), word("there.", 21, 30), word("Next", 60, 70)],
  createdAt: "2026-11-05T00:00:00Z",
});

const writeCache = (project: Project, transcript: unknown) => {
  NodeFS.mkdirSync(project.cacheDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(project.cacheDir, `${project.fingerprint.sha256}.json`),
    typeof transcript === "string" ? transcript : JSON.stringify(transcript),
  );
};

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
      // A copy found in another Hugging Face cache is passed on (S7V-067).
      expect(onSmall.profiles.light).toEqual({
        sizeBytes: 150,
        downloadedBytes: 50,
        ready: false,
        found: { copyBytes: 0 },
      });
      const onLarge = yield* TranscriptService.TranscriptService.pipe(
        Effect.flatMap((service) => service.modelsStatus),
        Effect.provide(large.layer),
      );
      expect(onLarge.recommended).toBe("default");
    }).pipe(Effect.ensuring(Effect.all([cleanup(small.project), cleanup(large.project)])));
  });

  it.effect(
    "asks once: a download or a dismissal is remembered, and tags the job's project",
    () => {
      const { layer, calls, project } = setup({ totalMemoryBytes: 8 * GB });
      return Effect.gen(function* () {
        const service = yield* TranscriptService.TranscriptService;
        expect((yield* service.dismissDownload).consent).toBe("dismissed");
        expect((yield* service.modelsStatus).consent).toBe("dismissed");
        const result = yield* service.downloadModels("light", projectId);
        expect(result).toEqual({ profile: "light", ready: true, sizeBytes: 1 });
        expect(calls.jobs).toEqual([
          {
            kind: "transcribe.models.download",
            method: "transcribe.models.download",
            params: { model: "light" },
            projectId,
            started: false,
          },
        ]);
        expect((yield* service.modelsStatus).consent).toBe("accepted");
        // Using the copy found on this Mac is the same job, told to reuse it.
        yield* service.downloadModels("light", undefined, "clone");
        expect(calls.jobs[1]?.params).toEqual({ model: "light", reuse: "clone" });
        const unknown = yield* service.downloadModels("light", unknownProject).pipe(Effect.flip);
        expect(unknown).toMatchObject({ _tag: "TranscriptError", reason: "media_refused" });
        expect(calls.jobs).toHaveLength(2);
      }).pipe(Effect.provide(layer), Effect.ensuring(cleanup(project)));
    },
  );

  it.effect("transcribes project media by id or path, fingerprinted on the server", () => {
    const { layer, calls, project } = setup({
      totalMemoryBytes: 36 * GB,
      ready: { default: false, light: true },
    });
    return Effect.gen(function* () {
      const service = yield* TranscriptService.TranscriptService;
      yield* service.transcribe({ projectId, media: "cam" });
      yield* service.transcribe({ projectId, media: "assets/clip.webm" });
      const expected = {
        kind: "transcribe",
        method: "transcribe.run",
        params: {
          path: project.clip,
          cacheDir: project.cacheDir,
          fingerprint: project.fingerprint,
          model: "light",
        },
        projectId,
        started: false,
      };
      expect(calls.jobs).toEqual([expected, expected]);
    }).pipe(Effect.provide(layer), Effect.ensuring(cleanup(project)));
  });

  it.effect("refuses media outside the project and unknown projects before the engine", () => {
    const { layer, calls, project } = setup({
      totalMemoryBytes: 36 * GB,
      ready: { default: true, light: false },
    });
    return Effect.gen(function* () {
      const service = yield* TranscriptService.TranscriptService;
      const refused = (input: { projectId: ProjectId; media: string }) =>
        Effect.all([
          service.transcribe(input).pipe(Effect.flip),
          service.start(input).pipe(Effect.flip),
          service.get(input).pipe(Effect.flip),
          service.readText(input).pipe(Effect.flip),
        ]);
      for (const media of [
        NodePath.join(project.outside, "secret.webm"), // absolute path outside
        "../Desktop/secret.webm", // relative path climbing out
        "escape", // an edit.json entry whose path climbs out
        "assets/link.webm", // a symlink inside that points outside
      ]) {
        for (const error of yield* refused({ projectId, media })) {
          expect(error).toMatchObject({ _tag: "TranscriptError", reason: "media_refused" });
          expect(error.message).toBe(NOT_IN_PROJECT);
        }
      }
      for (const error of yield* refused({ projectId: unknownProject, media: "cam" })) {
        expect(error).toMatchObject({ _tag: "TranscriptError", reason: "media_refused" });
        expect(error.message).toBe("Could not look up this project.");
      }
      expect(calls.jobs).toEqual([]);
      // Nothing was written outside the project.
      expect(NodeFS.readdirSync(project.outside)).toEqual(["secret.webm"]);
    }).pipe(Effect.provide(layer), Effect.ensuring(cleanup(project)));
  });

  it.effect("passes a missing model to the caller as models_missing", () => {
    const { layer, project } = setup({
      totalMemoryBytes: 36 * GB,
      jobError: new EngineError({ reason: "models_missing", method: "transcribe.run" }),
    });
    return Effect.gen(function* () {
      const service = yield* TranscriptService.TranscriptService;
      const error = yield* service.transcribe({ projectId, media: "cam" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "EngineError", reason: "models_missing" });
      expect(error.message).toContain("press Download speech model at the top of the Editor panel");
    }).pipe(Effect.provide(layer), Effect.ensuring(cleanup(project)));
  });

  it.effect("start: answers from the cache, refuses a missing model, else starts a job", () => {
    const missing = setup({ totalMemoryBytes: 36 * GB });
    const ready = setup({ totalMemoryBytes: 36 * GB, ready: { default: true, light: false } });
    return Effect.gen(function* () {
      const noModel = yield* TranscriptService.TranscriptService.pipe(
        Effect.flatMap((service) => service.start({ projectId, media: "cam" })),
        Effect.flip,
        Effect.provide(missing.layer),
      );
      expect(noModel).toMatchObject({ _tag: "EngineError", reason: "models_missing" });
      expect(missing.calls.jobs).toEqual([]);

      const service = TranscriptService.TranscriptService;
      const started = yield* service.pipe(
        Effect.flatMap((transcripts) => transcripts.start({ projectId, media: "cam" })),
        Effect.provide(ready.layer),
      );
      expect(started).toEqual({ jobId: "engine-job-7" });
      expect(ready.calls.jobs).toMatchObject([{ kind: "transcribe", projectId, started: true }]);

      writeCache(ready.project, transcriptFor(ready.project.fingerprint));
      const cached = yield* service.pipe(
        Effect.flatMap((transcripts) => transcripts.start({ projectId, media: "cam" })),
        Effect.provide(ready.layer),
      );
      expect(cached).toEqual({ cached: true, wordCount: 3, durationFrames: 300 });
      expect(ready.calls.jobs).toHaveLength(1);
    }).pipe(Effect.ensuring(Effect.all([cleanup(missing.project), cleanup(ready.project)])));
  });

  it.effect("reads the cached transcript and packs it as short frame-stamped lines", () => {
    const { layer, project } = setup({ totalMemoryBytes: 36 * GB });
    return Effect.gen(function* () {
      const service = yield* TranscriptService.TranscriptService;
      const input = { projectId, media: "cam" };
      expect(yield* service.get(input)).toBeNull();
      expect(yield* service.readText(input)).toBeNull();
      const transcript = transcriptFor(project.fingerprint);
      writeCache(project, transcript);
      expect(yield* service.get(input)).toEqual(transcript);
      expect(yield* service.readText(input)).toBe(
        "fps 30/1; [start-end] are frames of the clip.\n[10-30] Hello there.\n[60-70] Next",
      );
      expect(yield* service.readText({ ...input, fromFrame: 40 })).toBe(
        "fps 30/1; [start-end] are frames of the clip.\n[60-70] Next",
      );
      // A different file under the same name is not this media's transcript.
      writeCache(project, { ...transcript, mediaFingerprint: { ...project.fingerprint, size: 6 } });
      expect(yield* service.get(input)).toBeNull();
      writeCache(project, "{not json");
      const error = yield* service.get(input).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "TranscriptError", reason: "cache_unreadable" });
    }).pipe(Effect.provide(layer), Effect.ensuring(cleanup(project)));
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
