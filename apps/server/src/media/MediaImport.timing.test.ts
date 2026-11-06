// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off - hashes big files, drives Electron and prints timings for the ticket.
// Big-file checks for S7V-025 AC-1 (row and thumbnail split by S7V-064), AC-2, AC-3, AC-5 and AC-9, run by hand on a Mac with the
// real engine, the real /api/assets route and Electron's own Chromium for playback:
//   S7VIDEO_MEDIA_TIMING=1 S7VIDEO_BIG_CLIP=/abs/big4k.mp4 S7VIDEO_GOP10_CLIP=/abs/gop10.mp4 \
//     vp test run src/media/MediaImport.timing.test.ts
// Make the clips with spike A2's recipe (testsrc2 + noise, h264_videotoolbox 110 Mbit/s; -g 30 for
// the 2 GB file, -g 300 for the long-GOP one), in a scratch folder on the same volume as $TMPDIR.
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { layerEditTest } from "../edit/editHarness.testkit.ts";
import * as EngineService from "../engine/EngineService.ts";
import { layerAssetRoute } from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { SourceControlDrivers } from "../sourceControl/builtInDrivers.ts";
import * as MediaFiles from "./mediaFiles.ts";
import * as MediaLibraryService from "./MediaLibraryService.ts";

const ENABLED = process.env.S7VIDEO_MEDIA_TIMING === "1";
const BIG_CLIP = process.env.S7VIDEO_BIG_CLIP ?? "";
const GOP10_CLIP = process.env.S7VIDEO_GOP10_CLIP ?? "";
const SEEK_LIMIT_MS = 500;
const APPEAR_LIMIT_MS = 2_000;
const THUMBNAIL_LIMIT_MS = 3_000;
const CLONE_LIMIT_MS = 2_000;

const sha256OfFile = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    NodeFS.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const fileState = async (file: string) => ({
  sha256: await sha256OfFile(file),
  mtimeMs: NodeFS.statSync(file).mtimeMs,
});

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

/** Ten frames from a fixed-seed generator, as in spike A2. */
const seekFrames = (frameCount: number) => {
  let state = 20_261_105;
  return Array.from({ length: 10 }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return Math.floor((state / 2 ** 31) * (frameCount - 30)) + 15;
  });
};

interface SeekRun {
  readonly metadataMs: number;
  readonly seeks: ReadonlyArray<{
    readonly frame: number;
    readonly seekedMs: number;
    readonly presentedFrame: number | null;
  }>;
  readonly error?: string;
}

const DRIVER = `
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.S7_UD);
setTimeout(() => { console.log("RESULT " + JSON.stringify({ error: "timeout" })); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await w.loadURL("about:blank");
  const out = await w.webContents.executeJavaScript(\`(async () => {
    const url = \${JSON.stringify(process.env.S7_URL)};
    const fps = \${Number(process.env.S7_FPS_NUM)} / \${Number(process.env.S7_FPS_DEN)};
    const frames = \${process.env.S7_FRAMES};
    const once = (el, name) => new Promise((resolve, reject) => {
      el.addEventListener(name, resolve, { once: true });
      el.addEventListener("error", () => reject(new Error("video error " + (el.error && el.error.code))), { once: true });
    });
    const presented = (v) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      v.requestVideoFrameCallback((_now, meta) => { clearTimeout(timer); resolve(meta.mediaTime); });
    });
    try {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "metadata";
      document.body.appendChild(v);
      const t0 = performance.now();
      v.src = url;
      await once(v, "loadedmetadata");
      const metadataMs = performance.now() - t0;
      const seeks = [];
      for (const frame of frames) {
        // Registered before the seek, so the frame the seek presents is the one reported.
        const shown = presented(v);
        const start = performance.now();
        v.currentTime = (frame + 0.25) / fps;
        await once(v, "seeked");
        const seekedMs = performance.now() - start;
        const mediaTime = await shown;
        seeks.push({ frame, seekedMs, presentedFrame: mediaTime === null ? null : Math.floor(mediaTime * fps + 1e-6) });
      }
      return { metadataMs, seeks };
    } catch (error) { return { metadataMs: -1, seeks: [], error: String(error) }; }
  })()\`);
  console.log("RESULT " + JSON.stringify(out));
  app.quit();
});
`;

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");

/** Plays `url` in a hidden Electron window and seeks to each frame. */
const seekInElectron = (url: string, rate: { num: number; den: number }, frames: number[]) =>
  Effect.promise(async (): Promise<SeekRun> => {
    const electron = NodeModule.createRequire(NodePath.join(repoRoot, "apps/desktop/package.json"))(
      "electron",
    ) as string;
    const work = NodeFS.mkdtempSync(
      NodePath.join(NodeFS.realpathSync(process.env.TMPDIR ?? "/tmp"), "s7v-seek-"),
    );
    const script = NodePath.join(work, "main.js");
    NodeFS.writeFileSync(script, DRIVER);
    try {
      const output = await new Promise<string>((resolve) => {
        NodeChildProcess.execFile(
          electron,
          [script],
          {
            env: {
              ...process.env,
              S7_UD: NodePath.join(work, "user-data"),
              S7_URL: url,
              S7_FPS_NUM: String(rate.num),
              S7_FPS_DEN: String(rate.den),
              S7_FRAMES: JSON.stringify(frames),
            },
            maxBuffer: 16 * 1024 * 1024,
          },
          (_error, stdout) => resolve(stdout),
        );
      });
      const line = output.split("\n").find((entry) => entry.startsWith("RESULT "));
      return line
        ? (JSON.parse(line.slice("RESULT ".length)) as SeekRun)
        : { metadataMs: -1, seeks: [], error: output.slice(-500) };
    } finally {
      NodeFS.rmSync(work, { recursive: true, force: true });
    }
  });

const report = (label: string, run: SeekRun) => {
  const times = run.seeks.map((seek) => seek.seekedMs);
  console.log(
    `${label}: metadata ${run.metadataMs.toFixed(0)} ms; seeks median ${median(times).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms; ` +
      `frames ${run.seeks.map((seek) => `${seek.frame}->${seek.presentedFrame ?? "?"}`).join(" ")}${run.error ? `; error ${run.error}` : ""}`,
  );
};

const expectFastAccurateSeeks = (run: SeekRun) => {
  expect(run.error).toBeUndefined();
  expect(run.seeks).toHaveLength(10);
  for (const seek of run.seeks) {
    expect(seek.seekedMs).toBeLessThan(SEEK_LIMIT_MS);
    if (seek.presentedFrame !== null) {
      expect(Math.abs(seek.presentedFrame - seek.frame)).toBeLessThanOrEqual(1);
    }
  }
};

const withRoute = <A, E, R>(
  body: (input: {
    readonly baseUrl: string;
    readonly library: MediaLibraryService.MediaLibraryService["Service"];
    readonly newProject: (name: string) => Effect.Effect<{ projectId: ProjectId; root: string }>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-media-timing-" }),
    );
    const services = Layer.mergeAll(
      ServerSecretStore.layer,
      NativeAppIconResolver.layer,
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.succeed(SourceControlDrivers, [] as never),
      NodeHttpPlatform.layer,
    );
    const library = MediaLibraryService.layer.pipe(
      Layer.provideMerge(EngineService.layer),
      Layer.provideMerge(services),
      Layer.provideMerge(layerEditTest(baseDir)),
    );
    const served = yield* Layer.build(
      HttpRouter.serve(layerAssetRoute, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(library),
      ),
    );
    const baseUrl = HttpServer.formatAddress(Context.get(served, HttpServer.HttpServer).address);
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      return yield* body({
        baseUrl,
        library: yield* MediaLibraryService.MediaLibraryService,
        newProject: (name) =>
          folders.createNamedProject({ name }).pipe(
            Effect.map((created) => ({
              projectId: created.projectId,
              root: created.workspaceRoot,
            })),
            Effect.orDie,
          ),
      });
    }).pipe(Effect.provideContext(served));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.runIf(ENABLED)("media import timing (S7V-025)", () => {
  it.live(
    "AC-1, AC-2, AC-3, AC-9: a 2 GB 4K clip imports, plays and seeks, and stays untouched",
    () =>
      withRoute(({ baseUrl, library, newProject }) =>
        Effect.gen(function* () {
          const before = yield* Effect.promise(() => fileState(BIG_CLIP));
          expect(NodeFS.statSync(BIG_CLIP).size).toBeGreaterThan(2_000_000_000);

          // AC-1: by reference, in Assets with length and resolution within 2 s; the thumbnail
          // follows within 3 s (S7V-064).
          const referenced = yield* newProject("Big reference");
          // The engine is already running in a session that imports; time a warm import.
          const engine = yield* EngineService.EngineService;
          const cold = yield* timed(engine.ping);
          const steps = {
            probe: (yield* timed(engine.probe({ path: BIG_CLIP }))).ms,
            fingerprint: (yield* timed(MediaFiles.fingerprint(BIG_CLIP))).ms,
            keyframes: (yield* timed(engine.keyframes({ path: BIG_CLIP }))).ms,
          };
          console.log(
            `AC-1 steps: engine start ${cold.ms.toFixed(0)} ms, probe ${steps.probe.toFixed(0)} ms, fingerprint ${steps.fingerprint.toFixed(0)} ms, keyframe scan ${steps.keyframes.toFixed(0)} ms`,
          );
          const start = yield* Clock.currentTimeNanos;
          const since = Effect.map(Clock.currentTimeNanos, (now) => Number(now - start) / 1e6);
          // Times when the live Assets list first has the row, and then its thumbnail.
          const watched = yield* library.subscribe(referenced.projectId).pipe(
            Stream.mapEffect((snapshot) =>
              Effect.map(since, (ms) => ({ ms, item: snapshot.items[0] })),
            ),
            Stream.filter((seen) => seen.item !== undefined),
            Stream.takeUntil((seen) => seen.item!.hasThumbnail),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* library.import({
            projectId: referenced.projectId,
            sourcePath: BIG_CLIP,
            mode: "reference",
          });
          const replyMs = yield* since;
          const seen = Array.from(yield* Fiber.join(watched));
          const row = seen[0]!;
          const thumbnail = seen.at(-1)!;
          console.log(
            `AC-1: reference import to Assets row in ${row.ms.toFixed(0)} ms; thumbnail in ${thumbnail.ms.toFixed(0)} ms; import reply in ${replyMs.toFixed(0)} ms`,
          );
          expect(row.ms).toBeLessThan(APPEAR_LIMIT_MS);
          expect(row.item).toMatchObject({
            label: NodePath.basename(BIG_CLIP),
            sizeBytes: NodeFS.statSync(BIG_CLIP).size,
            width: 3840,
            height: 2160,
            durationFrames: 4800,
          });
          expect(thumbnail.item!.hasThumbnail).toBe(true);
          expect(thumbnail.ms).toBeLessThan(THUMBNAIL_LIMIT_MS);
          const [item] = (yield* library.list(referenced.projectId)).items;
          expect(item).toMatchObject({
            storage: "reference",
            state: "ready",
            hasThumbnail: true,
            proxy: { status: "none" },
          });

          // AC-2: plays and seeks through the project-media route.
          const issued = yield* issueAssetUrl({
            resource: {
              _tag: "project-media",
              projectId: referenced.projectId,
              mediaId: item!.id,
              variant: "original",
            },
          });
          const run = yield* seekInElectron(
            `${baseUrl}${issued.relativeUrl}`,
            item!.fps!,
            seekFrames(4800),
          );
          report("AC-2 original 2 GB 4K", run);
          expectFastAccurateSeeks(run);

          // AC-3: a copy on the same APFS volume is a clone: fast, and it uses no space.
          const copied = yield* newProject("Big copy");
          const assets = NodePath.join(copied.root, "assets");
          const clones = yield* MediaFiles.canClone(BIG_CLIP, assets, "darwin");
          const freeBefore = yield* MediaFiles.freeBytes(assets);
          const copy = yield* timed(
            library.import({ projectId: copied.projectId, sourcePath: BIG_CLIP, mode: "copy" }),
          );
          const used = freeBefore - (yield* MediaFiles.freeBytes(assets));
          console.log(
            `AC-3: copy import in ${copy.ms.toFixed(0)} ms (clone possible: ${clones}); free space used ${(used / 1024 ** 2).toFixed(0)} MB`,
          );
          expect(clones).toBe(true);
          expect(copy.ms).toBeLessThan(CLONE_LIMIT_MS);
          expect(used).toBeLessThan(200 * 1024 ** 2);
          const copyFile = NodePath.join(copied.root, "assets", `${copy.value.mediaId}.mp4`);
          expect(yield* MediaFiles.fingerprint(copyFile)).toEqual(
            yield* MediaFiles.fingerprint(BIG_CLIP),
          );

          // AC-9: the original's bytes and mtime are unchanged after import and playback.
          expect(yield* Effect.promise(() => fileState(BIG_CLIP))).toEqual(before);
        }),
      ),
  );

  it.live("AC-5, AC-9: a 4K 10 s GOP clip gets a proxy that seeks under 0.5 s", () =>
    withRoute(({ baseUrl, library, newProject }) =>
      Effect.gen(function* () {
        const before = yield* Effect.promise(() => fileState(GOP10_CLIP));
        const project = yield* newProject("Long GOP");
        const started = yield* timed(
          library.import({
            projectId: project.projectId,
            sourcePath: GOP10_CLIP,
            mode: "reference",
          }),
        );
        expect(started.value.jobId).toBeDefined();
        const ready = yield* timed(
          library.subscribe(project.projectId).pipe(
            Stream.filter((snapshot) =>
              snapshot.items.some((entry) => entry.proxy.status !== "preparing"),
            ),
            Stream.runHead,
          ),
        );
        const item = (yield* library.list(project.projectId)).items[0]!;
        console.log(
          `AC-5: import ${started.ms.toFixed(0)} ms, proxy job ${started.value.jobId}, proxy ${item.proxy.status} after ${(ready.ms / 1000).toFixed(1)} s`,
        );
        expect(item.proxy.status).toBe("ready");

        const urlOf = (variant: "original" | "proxy") =>
          issueAssetUrl({
            resource: {
              _tag: "project-media",
              projectId: project.projectId,
              mediaId: item.id,
              variant,
            },
          }).pipe(Effect.map((issued) => `${baseUrl}${issued.relativeUrl}`));
        const frames = seekFrames(item.durationFrames!);
        report(
          "AC-5 original 10 s GOP (for comparison)",
          yield* seekInElectron(yield* urlOf("original"), item.fps!, frames),
        );
        const proxyRun = yield* seekInElectron(yield* urlOf("proxy"), item.fps!, frames);
        report("AC-5 proxy", proxyRun);
        expectFastAccurateSeeks(proxyRun);
        expect(yield* Effect.promise(() => fileState(GOP10_CLIP))).toEqual(before);
      }),
    ),
  );
});
