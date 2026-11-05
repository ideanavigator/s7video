// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder and git directly.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EngineError,
  type EngineJobId,
  type ExportRenderResult,
  type ExportStatus,
  ProjectId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isIgnored, layerEditTest } from "../edit/editHarness.testkit.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ExportService from "./ExportService.ts";

interface RunJobCall {
  readonly kind: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const rendered = (path: string): ExportRenderResult => ({
  path,
  durationFrames: 1438,
  fps: { num: 24000, den: 1001 },
  width: 1080,
  height: 1920,
  captions: 11,
  measuredLufs: -21.1,
  gainDb: 7.1,
  lufs: -14.3,
  truePeak: -1.4,
});

/** An engine whose export jobs finish when the test says so. */
const fakeEngine = (
  calls: Array<RunJobCall>,
  outcome: Deferred.Deferred<"ok" | "cancelled" | "no-libass">,
) => {
  let counter = 0;
  const runJob: EngineService.EngineService["Service"]["runJob"] = (input) =>
    Effect.gen(function* () {
      counter += 1;
      calls.push({ kind: input.kind, method: input.method, params: input.params });
      if (input.onStart) yield* input.onStart(`engine-job-${counter}` as EngineJobId);
      const result = yield* Deferred.await(outcome);
      if (result === "cancelled") {
        return yield* new EngineError({ reason: "cancelled", method: input.method });
      }
      if (result === "no-libass") {
        return yield* new EngineError({
          reason: "missing_tool",
          method: input.method,
          tool: "ffmpeg",
          feature: "libass",
        });
      }
      const output = String(input.params.outputPath);
      NodeFS.writeFileSync(output, "mp4");
      return rendered(output) as never;
    });
  return Layer.mock(EngineService.EngineService)({
    runJob,
    cancelJob: () => Effect.succeed(true),
    subscribeJobs: Stream.empty,
  });
};

const withExports = <A, E>(
  outcome: "ok" | "cancelled" | "no-libass",
  body: (input: {
    readonly projectId: ProjectId;
    readonly root: string;
    readonly exports: ExportService.ExportService["Service"];
    readonly calls: ReadonlyArray<RunJobCall>;
    readonly finish: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-export-" });
    const calls: Array<RunJobCall> = [];
    const done = yield* Deferred.make<"ok" | "cancelled" | "no-libass">();
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const exports = yield* ExportService.ExportService;
      const created = yield* folders.createNamedProject({ name: "My Reel #2" });
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        exports,
        calls,
        finish: Deferred.succeed(done, outcome).pipe(Effect.asVoid),
      });
    }).pipe(
      Effect.provide(
        ExportService.layer.pipe(
          Layer.provide(fakeEngine(calls, done)),
          Layer.provideMerge(layerEditTest(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const settled = (exports: ExportService.ExportService["Service"], jobId: EngineJobId) =>
  exports.wait(jobId).pipe(Effect.map((status) => status as ExportStatus));

describe("ExportService", () => {
  it("names exports after the project and the local minute", () => {
    assert.strictEqual(ExportService.exportSlug("My Reel #2"), "my-reel-2");
    assert.strictEqual(ExportService.exportSlug("Café déjà vu"), "cafe-deja-vu");
    assert.strictEqual(ExportService.exportSlug("!!!"), "export");
    assert.match(ExportService.exportStamp(Date.UTC(2026, 10, 5, 12, 34)), /^20261\d{3}-\d{4}$/u);
  });

  it.effect("starts an export job into exports/ and reports the finished file", () =>
    withExports("ok", ({ projectId, root, exports, calls, finish }) =>
      Effect.gen(function* () {
        const started = yield* exports.start({ projectId, preset: "square" });
        assert.match(started.path, /^exports\/my-reel-2-\d{8}-\d{4}\.mp4$/u);
        assert.deepStrictEqual(yield* exports.status(started.jobId), {
          jobId: started.jobId,
          projectId,
          path: started.path,
          state: "running",
        } satisfies ExportStatus);

        const [call] = calls;
        assert.isDefined(call);
        assert.strictEqual(call.kind, "export");
        assert.strictEqual(call.method, "export.render");
        assert.strictEqual(call.params.projectDir, NodePath.resolve(root));
        assert.strictEqual(
          call.params.outputPath,
          NodePath.join(NodePath.resolve(root), started.path),
        );
        // Captions are on unless asked off (PO default), and the preset sets the canvas.
        assert.strictEqual(call.params.captions, true);
        assert.deepStrictEqual(call.params.canvas, { width: 1080, height: 1080 });
        assert.deepInclude(call.params.edit as object, { version: 1 });

        yield* finish;
        const status = yield* settled(exports, started.jobId);
        assert.strictEqual(status.state, "succeeded");
        assert.deepStrictEqual(status.result, {
          path: started.path,
          durationFrames: 1438,
          fps: { num: 24000, den: 1001 },
          width: 1080,
          height: 1920,
          captions: 11,
          lufs: -14.3,
          truePeak: -1.4,
        });
        // The video is in the project but never in its history.
        assert.isTrue(NodeFS.existsSync(NodePath.join(root, started.path)));
        assert.isTrue(isIgnored(root, started.path));
      }),
    ),
  );

  it.effect("never reuses a name, even while the first export is still writing", () =>
    withExports("ok", ({ projectId, exports, calls }) =>
      Effect.gen(function* () {
        const first = yield* exports.start({ projectId, captions: false });
        const second = yield* exports.start({ projectId });
        assert.notStrictEqual(first.path, second.path);
        assert.match(second.path, /-2\.mp4$/u);
        assert.strictEqual(calls[0]?.params.captions, false);
        assert.isUndefined(calls[0]?.params.canvas);
      }),
    ),
  );

  it.effect("records a cancelled export without a message", () =>
    withExports("cancelled", ({ projectId, exports, finish }) =>
      Effect.gen(function* () {
        const started = yield* exports.start({ projectId });
        yield* finish;
        const status = yield* settled(exports, started.jobId);
        assert.strictEqual(status.state, "cancelled");
        assert.isUndefined(status.message);
      }),
    ),
  );

  it.effect("records a failed export with a plain message naming libass", () =>
    withExports("no-libass", ({ projectId, exports, finish }) =>
      Effect.gen(function* () {
        const started = yield* exports.start({ projectId });
        yield* finish;
        const status = yield* settled(exports, started.jobId);
        assert.strictEqual(status.state, "failed");
        assert.include(status.message, "libass");
      }),
    ),
  );

  it.effect("refuses a project that is not an edit project", () =>
    withExports("ok", ({ exports }) =>
      Effect.gen(function* () {
        const error = yield* exports
          .start({ projectId: ProjectId.make("no-such-project") })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "EditUnavailableError");
        assert.isNull(yield* exports.status("engine-job-404" as EngineJobId));
        assert.isNull(yield* exports.wait("engine-job-404" as EngineJobId));
      }),
    ),
  );
});
