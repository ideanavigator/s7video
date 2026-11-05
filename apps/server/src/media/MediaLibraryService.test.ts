// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Builds source files and checks the project on disk.
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EngineError,
  EngineJobId,
  type MediaProbeResult,
  type MediaProxyInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { git, isIgnored, layerEditTest } from "../edit/editHarness.testkit.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as MediaFiles from "./mediaFiles.ts";
import * as MediaLibraryService from "./MediaLibraryService.ts";
import { mediaIdFor, toEditProbe } from "./MediaLibraryService.ts";

const MIB = 1024 * 1024;

const videoProbe = (path: string): MediaProbeResult => ({
  path,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  sizeBytes: 3 * MIB,
  bitRate: 8_000_000,
  durationFrames: 300,
  video: {
    index: 0,
    codec: "h264",
    profile: "High",
    width: 1920,
    height: 1080,
    pixelFormat: "yuv420p",
    frameRate: { num: 30, den: 1 },
    averageFrameRate: { num: 30, den: 1 },
    variableFrameRate: false,
    timeBase: { num: 1, den: 15_360 },
    firstPts: 0,
    lastPts: 153_088,
    frameCount: 300,
    durationFrames: 300,
    rotation: 0,
    color: { space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" },
  },
  audio: null,
});

const audioProbe = (path: string): MediaProbeResult => ({
  path,
  container: "wav",
  sizeBytes: 1,
  bitRate: null,
  durationFrames: null,
  video: null,
  audio: {
    index: 0,
    codec: "pcm_s16le",
    sampleRate: 48_000,
    channels: 2,
    channelLayout: "stereo",
    timeBase: { num: 1, den: 48_000 },
    firstPts: 0,
    durationSamples: 96_000,
  },
});

interface FakeEngine {
  /** Longest keyframe gap the fake reports, in seconds. */
  gapSeconds: number;
  /** Settles each proxy job: succeed, or fail with an engine error. Replaceable between jobs. */
  proxyOutcome: Deferred.Deferred<"succeed" | "cancelled" | "failed">;
  readonly proxies: Array<MediaProxyInput>;
  readonly probed: Array<string>;
}

const layerFakeEngine = (fake: FakeEngine) =>
  Layer.mock(EngineService.EngineService)({
    probe: ({ path }) =>
      Effect.suspend(() => {
        fake.probed.push(path);
        if (NodeFS.statSync(path).size === 0) {
          return Effect.fail(
            new EngineError({
              reason: "rpc_error",
              method: "media.probe",
              rpcMessage: "ffprobe could not read the media",
            }),
          );
        }
        return Effect.succeed(path.endsWith(".wav") ? audioProbe(path) : videoProbe(path));
      }),
    thumbnail: ({ outputPath }) =>
      Effect.sync(() => {
        NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
        NodeFS.writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff]));
        return { path: outputPath };
      }),
    keyframes: () =>
      Effect.sync(() => ({
        timeBase: { num: 1, den: 15_360 },
        maxGapTicks: fake.gapSeconds * 15_360,
        keyframes: 3,
        scannedTicks: 10 * 15_360,
      })),
    proxy: ({ onStart, projectId: _projectId, ...input }) =>
      Effect.gen(function* () {
        fake.proxies.push(input);
        if (onStart) yield* onStart(EngineJobId.make(`engine-job-${fake.proxies.length}`));
        const outcome = yield* Deferred.await(fake.proxyOutcome);
        if (outcome !== "succeed") {
          return yield* new EngineError({
            reason: outcome === "cancelled" ? "cancelled" : "rpc_error",
            method: "media.proxy",
          });
        }
        NodeFS.mkdirSync(NodePath.dirname(input.outputPath), { recursive: true });
        NodeFS.writeFileSync(input.outputPath, "proxy");
        return { path: input.outputPath };
      }),
    subscribeJobs: Stream.never,
  });

const layerAssetRoute = Layer.mergeAll(
  ServerSecretStore.layer,
  NativeAppIconResolver.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  NodeHttpPlatform.layer,
);

interface Harness {
  readonly projectId: ProjectId;
  readonly root: string;
  /** A folder outside the project, standing in for the user's Desktop. */
  readonly desktop: string;
  readonly fake: FakeEngine;
  readonly library: MediaLibraryService.MediaLibraryService["Service"];
  readonly edits: EditDocumentService.EditDocumentService["Service"];
  readonly newProject: () => Effect.Effect<ProjectId>;
}

const withLibrary = <A, E, R>(
  body: (harness: Harness) => Effect.Effect<A, E, R>,
  options: MediaLibraryService.MediaLibraryOptions & { readonly platform?: NodeJS.Platform } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-media-" }),
    );
    const desktop = NodePath.join(baseDir, "Desktop");
    NodeFS.mkdirSync(desktop);
    const fake: FakeEngine = {
      gapSeconds: 1,
      proxyOutcome: yield* Deferred.make<"succeed" | "cancelled" | "failed">(),
      proxies: [],
      probed: [],
    };
    const layer = MediaLibraryService.layerWith(options).pipe(
      Layer.provide(layerFakeEngine(fake)),
      Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
      Layer.provideMerge(layerAssetRoute),
      Layer.provideMerge(layerEditTest(baseDir)),
    );
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      let projects = 0;
      const newProject = () =>
        Effect.suspend(() => {
          projects += 1;
          return folders.createNamedProject({ name: `Other project ${projects}` });
        }).pipe(
          Effect.map((created) => created.projectId),
          Effect.orDie,
        );
      const created = yield* folders.createNamedProject({ name: "Media test" });
      return yield* body({
        projectId: created.projectId,
        root: NodeFS.realpathSync(created.workspaceRoot),
        desktop,
        fake,
        library: yield* MediaLibraryService.MediaLibraryService,
        edits: yield* EditDocumentService.EditDocumentService,
        newProject,
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** A file whose first and last MiB differ, so the fingerprint sees both ends. */
const writeClip = (folder: string, name: string, seed = 1, size = 3 * MIB) => {
  const file = NodePath.join(folder, name);
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 4096) bytes[index] = (index / 4096 + seed) % 251;
  NodeFS.writeFileSync(file, bytes);
  return file;
};

const editJson = (root: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8")) as {
    media: Array<Record<string, unknown>>;
  };

const fileState = (file: string) => {
  const info = NodeFS.statSync(file);
  return { bytes: NodeFS.readFileSync(file), mtimeMs: info.mtimeMs, ino: info.ino };
};

describe("MediaLibraryService", () => {
  it.effect("fingerprint hashes first and last MiB plus size", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const folder = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-fp-" });
      const clip = writeClip(folder, "a.mp4");
      const copy = NodePath.join(folder, "copy.mp4");
      NodeFS.copyFileSync(clip, copy);
      const original = yield* MediaFiles.fingerprint(clip);
      assert.deepEqual(yield* MediaFiles.fingerprint(copy), original);
      assert.equal(original.size, 3 * MIB);
      assert.match(original.sha256, /^[0-9a-f]{64}$/u);
      // A change in the middle MiB is not seen (by design); one in the last MiB is.
      const tail = Buffer.from(NodeFS.readFileSync(copy));
      tail[tail.length - 1] = tail[tail.length - 1]! ^ 0xff;
      NodeFS.writeFileSync(copy, tail);
      assert.notEqual((yield* MediaFiles.fingerprint(copy)).sha256, original.sha256);
      const small = NodePath.join(folder, "small.wav");
      NodeFS.writeFileSync(small, "tiny");
      assert.equal((yield* MediaFiles.fingerprint(small)).size, 4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("claims a free name without hard links, never replacing an existing file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const folder = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-publish-" });
      NodeFS.writeFileSync(NodePath.join(folder, "cam.mp4"), "kept copy");
      const noLinks = (code: string) => async () => {
        throw Object.assign(new Error("no hard links"), { code });
      };
      for (const [index, code] of ["ENOTSUP", "EPERM"].entries()) {
        const partial = NodePath.join(folder, `.cam.${index}.part`);
        NodeFS.writeFileSync(partial, `new ${index}`);
        const name = yield* MediaFiles.publishExclusive(
          partial,
          folder,
          "cam",
          ".mp4",
          noLinks(code),
        );
        assert.equal(name, `cam-${index + 2}.mp4`);
        assert.equal(NodeFS.readFileSync(NodePath.join(folder, name), "utf8"), `new ${index}`);
        assert.isFalse(NodeFS.existsSync(partial));
      }
      assert.equal(NodeFS.readFileSync(NodePath.join(folder, "cam.mp4"), "utf8"), "kept copy");
      // Any other link failure is a real error, not a reason to claim a name.
      const partial = NodePath.join(folder, ".cam.x.part");
      NodeFS.writeFileSync(partial, "x");
      const failed = yield* MediaFiles.publishExclusive(
        partial,
        folder,
        "cam",
        ".mp4",
        noLinks("EIO"),
      ).pipe(Effect.flip);
      assert.equal(failed._tag, "MediaFileError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("names media after the file, uniquely and safely", () => {
    assert.equal(mediaIdFor("Interview 4K (take 2).MOV", new Set()), "interview-4k-take-2");
    assert.equal(mediaIdFor("cam.mp4", new Set(["cam"])), "cam-2");
    assert.equal(mediaIdFor("cam.mp4", new Set(["cam", "cam-2"])), "cam-3");
    assert.equal(mediaIdFor("..mp4", new Set()), "clip");
    assert.equal(mediaIdFor("日本語.mp4", new Set()), "clip");
  });

  it("records probe lengths in document frames and display size after rotation", () => {
    const phone = videoProbe("/clip.mov");
    const rotated = toEditProbe(
      { ...phone, video: { ...phone.video!, rotation: 90, frameRate: { num: 60, den: 1 } } },
      { num: 30, den: 1 },
    );
    assert.deepInclude(rotated, { width: 1080, height: 1920, durationFrames: 150 });
    assert.deepInclude(toEditProbe(audioProbe("/a.wav"), { num: 30, den: 1 }), {
      durationFrames: 60,
      hasVideo: false,
      hasAudio: true,
      sampleRate: 48_000,
      audioChannels: 2,
    });
  });

  it.effect("import by reference records absolute path", () =>
    withLibrary(({ projectId, root, desktop, library }) =>
      Effect.gen(function* () {
        const clip = writeClip(desktop, "cam.mp4");
        const before = fileState(clip);
        const result = yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        assert.deepEqual(result, { mediaId: "cam" });
        const [media] = editJson(root).media;
        assert.deepInclude(media, { id: "cam", kind: "video", reference: clip, label: "cam.mp4" });
        assert.isUndefined(media!.path);
        assert.deepInclude(media!.probe as object, {
          durationFrames: 300,
          width: 1920,
          height: 1080,
          fps: { num: 30, den: 1 },
        });
        const { items, importing } = yield* library.list(projectId);
        assert.deepEqual(importing, []);
        assert.deepInclude(items[0], {
          id: "cam",
          storage: "reference",
          location: clip,
          state: "ready",
          sizeBytes: 3 * MIB,
          durationFrames: 300,
          hasThumbnail: true,
          proxy: { status: "none" },
        });
        // Nothing was copied, and the original is untouched.
        assert.deepEqual(
          NodeFS.readdirSync(NodePath.join(root, "assets")).filter((name) => name !== "icon.svg"),
          [],
        );
        assert.deepEqual(fileState(clip), before);
      }),
    ),
  );

  it.effect("imports by copy into the ignored assets folder and keeps the original untouched", () =>
    withLibrary(({ projectId, root, desktop, library, edits }) =>
      Effect.gen(function* () {
        const clip = writeClip(desktop, "Cam A.MP4");
        const before = fileState(clip);
        const { mediaId } = yield* library.import({ projectId, sourcePath: clip, mode: "copy" });
        assert.equal(mediaId, "cam-a");
        const copy = NodePath.join(root, "assets", "cam-a.mp4");
        assert.deepEqual(NodeFS.readFileSync(copy), before.bytes);
        assert.deepInclude(editJson(root).media[0], { path: "assets/cam-a.mp4" });
        // The media guard did not trip: the copy is ignored and the edit has history.
        assert.isTrue(isIgnored(root, "assets/cam-a.mp4"));
        assert.notInclude(git(root, "status", "--porcelain", "--ignored=no"), "cam-a");
        assert.isTrue((yield* edits.read(projectId)).canUndo);
        assert.deepEqual(fileState(clip), before);
        assert.deepEqual(
          NodeFS.readdirSync(NodePath.join(root, "assets")).filter((name) =>
            name.endsWith(".part"),
          ),
          [],
        );
        const [item] = (yield* library.list(projectId)).items;
        assert.deepInclude(item, { storage: "copy", location: "assets/cam-a.mp4", state: "ready" });
      }),
    ),
  );

  it.effect("should fall back to streamed copy when clone fails", () =>
    withLibrary(
      ({ projectId, root, desktop, library }) =>
        Effect.gen(function* () {
          const clip = writeClip(desktop, "cam.mov", 7);
          // Off macOS (or across volumes) no clone is attempted.
          assert.isFalse(yield* MediaFiles.canClone(clip, NodePath.join(root, "assets"), "linux"));
          // The streamed copy reports progress the Assets list shows while it runs.
          const big = writeClip(desktop, "big.mov", 8, 40 * MIB);
          const progress: number[] = [];
          yield* MediaFiles.streamCopy(big, NodePath.join(desktop, "big-copy.mov"), (value) =>
            progress.push(value),
          );
          assert.isAtLeast(progress.length, 9);
          assert.deepEqual(
            progress,
            progress.toSorted((a, b) => a - b),
          );
          assert.equal(progress.at(-1), 1);
          yield* library.import({ projectId, sourcePath: clip, mode: "copy" });
          assert.deepEqual(
            NodeFS.readFileSync(NodePath.join(root, "assets", "cam.mov")),
            NodeFS.readFileSync(clip),
          );
          assert.deepEqual((yield* library.list(projectId)).importing, []);
        }),
      { platform: "linux" },
    ),
  );

  it.effect("should not default to copy when disk is short", () =>
    Effect.gen(function* () {
      yield* withLibrary(
        ({ projectId, desktop, library }) =>
          Effect.gen(function* () {
            const plan = yield* library.plan({
              projectId,
              sourcePaths: [writeClip(desktop, "a.mp4"), writeClip(desktop, "b.mp4", 2)],
            });
            assert.equal(plan.suggestedMode, "copy");
            assert.equal(plan.totalBytes, 6 * MIB);
            assert.isUndefined(plan.reason);
          }),
        { copyFreeMarginBytes: 0 },
      );
      yield* withLibrary(
        ({ projectId, desktop, library }) =>
          Effect.gen(function* () {
            const plan = yield* library.plan({
              projectId,
              sourcePaths: [writeClip(desktop, "a.mp4")],
            });
            assert.equal(plan.suggestedMode, "reference");
            assert.match(plan.reason ?? "", /free/u);
            const missing = yield* library
              .plan({ projectId, sourcePaths: [NodePath.join(desktop, "nope.mp4")] })
              .pipe(Effect.flip);
            assert.equal(missing.reason, "not-found");
          }),
        { copyFreeMarginBytes: Number.MAX_SAFE_INTEGER },
      );
    }),
  );

  it.effect("should show missing and relink by fingerprint", () =>
    withLibrary(({ projectId, desktop, library }) =>
      Effect.gen(function* () {
        const clip = writeClip(desktop, "cam.mp4");
        yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        const moved = NodePath.join(desktop, "Moved", "cam.mp4");
        NodeFS.mkdirSync(NodePath.dirname(moved));
        NodeFS.renameSync(clip, moved);
        assert.equal((yield* library.list(projectId)).items[0]!.state, "missing");

        const stranger = writeClip(desktop, "other.mp4", 9);
        const refused = yield* library
          .relink({ projectId, mediaId: "cam", sourcePath: stranger })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "different-file");
        assert.equal((yield* library.list(projectId)).items[0]!.state, "missing");

        yield* library.relink({ projectId, mediaId: "cam", sourcePath: moved });
        assert.deepInclude((yield* library.list(projectId)).items[0], {
          state: "ready",
          location: moved,
        });
        // Deleted outright: missing again.
        NodeFS.rmSync(moved);
        assert.equal((yield* library.list(projectId)).items[0]!.state, "missing");
        const unknown = yield* library
          .relink({ projectId, mediaId: "nope", sourcePath: stranger })
          .pipe(Effect.flip);
        assert.equal(unknown.reason, "unknown-media");
      }),
    ),
  );

  it.effect("should handle a 0-byte or truncated file", () =>
    withLibrary(({ projectId, root, desktop, library }) =>
      Effect.gen(function* () {
        const empty = NodePath.join(desktop, "empty.mp4");
        NodeFS.writeFileSync(empty, "");
        for (const mode of ["copy", "reference"] as const) {
          const error = yield* library
            .import({ projectId, sourcePath: empty, mode })
            .pipe(Effect.flip);
          assert.equal(error.reason, "unreadable");
          assert.equal(error.explanation, "s7video could not read this file as video or audio.");
        }
        assert.deepEqual(editJson(root).media, []);
        const folder = yield* library
          .import({ projectId, sourcePath: desktop, mode: "copy" })
          .pipe(Effect.flip);
        assert.equal(folder.reason, "not-a-media-file");
      }),
    ),
  );

  it.effect("should import audio dropped in chat", () =>
    withLibrary(({ projectId, desktop, library }) =>
      Effect.gen(function* () {
        const sound = writeClip(desktop, "whoosh.wav", 3, 200_000);
        yield* library.import({ projectId, sourcePath: sound, mode: "copy" });
        const snapshot = yield* library.list(projectId);
        assert.deepInclude(snapshot.items[0], {
          id: "whoosh",
          kind: "audio",
          hasVideo: false,
          hasAudio: true,
          hasThumbnail: false,
          durationFrames: 60,
          proxy: { status: "none" },
        });
        assert.deepEqual(snapshot.fps, { num: 30, den: 1 });
      }),
    ),
  );

  it.effect("imports the same file once", () =>
    withLibrary(({ projectId, root, desktop, library }) =>
      Effect.gen(function* () {
        const clip = writeClip(desktop, "cam.mp4");
        yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        const again = yield* library.import({ projectId, sourcePath: clip, mode: "copy" });
        assert.deepEqual(again, { mediaId: "cam" });
        assert.equal(editJson(root).media.length, 1);
      }),
    ),
  );

  it.effect("long-GOP clip gets a background proxy; below the thresholds gets none", () =>
    withLibrary(({ projectId, root, desktop, library, fake }) =>
      Effect.gen(function* () {
        const plain = yield* library.import({
          projectId,
          sourcePath: writeClip(desktop, "plain.mp4", 4),
          mode: "reference",
        });
        assert.isUndefined(plain.jobId);
        assert.deepEqual(fake.proxies, []);

        fake.gapSeconds = 10;
        const clip = writeClip(desktop, "phone.mp4", 5);
        const before = fileState(clip);
        const result = yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        assert.equal(result.jobId, "engine-job-1");
        assert.deepInclude(fake.proxies[0], {
          path: clip,
          rate: { num: 30, den: 1 },
          durationFrames: 300,
          color: { space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" },
        });
        assert.include(fake.proxies[0]!.outputPath, NodePath.join(root, ".s7cache", "proxies"));
        const preparing = (yield* library.list(projectId)).items.find(
          (item) => item.id === "phone",
        );
        assert.deepInclude(preparing!.proxy, {
          status: "preparing",
          jobId: EngineJobId.make("engine-job-1"),
        });

        yield* Deferred.succeed(fake.proxyOutcome, "succeed");
        const ready = yield* library.subscribe(projectId).pipe(
          Stream.filter((snapshot) =>
            snapshot.items.some((item) => item.id === "phone" && item.proxy.status === "ready"),
          ),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(ready));
        assert.isTrue(
          isIgnored(root, `.s7cache/proxies/${NodePath.basename(fake.proxies[0]!.outputPath)}`),
        );
        assert.deepEqual(fileState(clip), before);
      }),
    ),
  );

  it.effect("should cancel a proxy job without calling it failed", () =>
    withLibrary(({ projectId, desktop, library, fake }) =>
      Effect.gen(function* () {
        fake.gapSeconds = 10;
        yield* library.import({
          projectId,
          sourcePath: writeClip(desktop, "phone.mp4"),
          mode: "reference",
        });
        yield* Deferred.succeed(fake.proxyOutcome, "cancelled");
        const settled = yield* library.subscribe(projectId).pipe(
          Stream.map((snapshot) => snapshot.items[0]!.proxy.status),
          Stream.filter((status) => status !== "preparing"),
          Stream.runHead,
        );
        assert.equal(Option.getOrUndefined(settled), "none");
      }),
    ),
  );

  it.effect("serves cache files only from inside the project's .s7cache", () =>
    withLibrary(({ projectId, root, desktop, library }) =>
      Effect.gen(function* () {
        const clip = writeClip(desktop, "cam.mp4");
        yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        const sha = (editJson(root).media[0]!.fingerprint as { sha256: string }).sha256;
        const thumb = NodePath.join(root, ".s7cache", "thumbs", `${sha}.jpg`);
        assert.isTrue(Option.isSome(yield* library.resolveVariant(projectId, "cam", "thumbnail")));
        // A cache entry swapped for a symlink to a file elsewhere is not served.
        const secret = NodePath.join(desktop, "secret.txt");
        NodeFS.writeFileSync(secret, "private");
        NodeFS.rmSync(thumb);
        NodeFS.symlinkSync(secret, thumb);
        assert.isTrue(Option.isNone(yield* library.resolveVariant(projectId, "cam", "thumbnail")));
        // Nor through a symlinked cache folder.
        const proxies = NodePath.join(root, ".s7cache", "proxies");
        NodeFS.rmSync(proxies, { recursive: true, force: true });
        NodeFS.mkdirSync(NodePath.join(desktop, "elsewhere"));
        NodeFS.writeFileSync(NodePath.join(desktop, "elsewhere", `${sha}.mp4`), "x");
        NodeFS.symlinkSync(NodePath.join(desktop, "elsewhere"), proxies);
        assert.isTrue(Option.isNone(yield* library.resolveVariant(projectId, "cam", "proxy")));
      }),
    ),
  );

  it.effect("never replaces a kept copy, and undo finds the original bytes again", () =>
    withLibrary(({ projectId, root, desktop, library, edits }) =>
      Effect.gen(function* () {
        const first = writeClip(desktop, "cam.mp4", 1);
        yield* library.import({ projectId, sourcePath: first, mode: "copy" });
        const kept = NodePath.join(root, "assets", "cam.mp4");
        const keptBytes = NodeFS.readFileSync(kept);
        // Removing the clip keeps its copy in assets/.
        const removed = yield* edits.read(projectId);
        yield* edits.apply(projectId, [{ _tag: "removeMedia", mediaId: "cam" }], {
          origin: "timeline",
          baseRevision: removed.revision,
        });
        NodeFS.mkdirSync(NodePath.join(desktop, "Other"));
        const second = writeClip(NodePath.join(desktop, "Other"), "cam.mp4", 2);
        yield* library.import({ projectId, sourcePath: second, mode: "copy" });
        assert.deepEqual(NodeFS.readFileSync(kept), keptBytes);
        assert.deepEqual(
          NodeFS.readFileSync(NodePath.join(root, "assets", "cam-2.mp4")),
          NodeFS.readFileSync(second),
        );
        assert.deepInclude(editJson(root).media[0], { id: "cam", path: "assets/cam-2.mp4" });
        // Undo the import and the removal: the first clip is back on its own bytes.
        yield* edits.undo(projectId);
        yield* edits.undo(projectId);
        assert.deepInclude((yield* library.list(projectId)).items[0], {
          location: "assets/cam.mp4",
          state: "ready",
        });
        // Different bytes of the same size at a recorded path are missing, not the clip.
        const tampered = Buffer.from(keptBytes);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
        NodeFS.writeFileSync(kept, tampered);
        assert.equal((yield* library.list(projectId)).items[0]!.state, "missing");
      }),
    ),
  );

  it.effect("two imports of same-named files at once keep both", () =>
    withLibrary(({ projectId, root, desktop, library }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(desktop, "A"));
        NodeFS.mkdirSync(NodePath.join(desktop, "B"));
        const a = writeClip(NodePath.join(desktop, "A"), "take.mp4", 3);
        const b = writeClip(NodePath.join(desktop, "B"), "take.mp4", 4);
        const results = yield* Effect.forEach(
          [a, b],
          (sourcePath) => library.import({ projectId, sourcePath, mode: "copy" }),
          { concurrency: "unbounded" },
        );
        const ids = results.map((result) => result.mediaId).toSorted();
        assert.deepEqual(ids, ["take", "take-2"]);
        const media = editJson(root).media as Array<{ id: string; path: string }>;
        assert.equal(new Set(media.map((entry) => entry.path)).size, 2);
        for (const [source, result] of [a, b].map(
          (file, index) => [file, results[index]!] as const,
        )) {
          const entry = media.find((candidate) => candidate.id === result.mediaId)!;
          assert.deepEqual(
            NodeFS.readFileSync(NodePath.join(root, entry.path)),
            NodeFS.readFileSync(source),
          );
        }
        assert.isTrue(
          (yield* library.list(projectId)).items.every((item) => item.state === "ready"),
        );
      }),
    ),
  );

  it.effect("retries a failed proxy on re-import, and a missing one on first list", () =>
    withLibrary(({ projectId, root, desktop, library, edits, fake }) =>
      Effect.gen(function* () {
        fake.gapSeconds = 10;
        const clip = writeClip(desktop, "phone.mp4", 5);
        yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        yield* Deferred.succeed(fake.proxyOutcome, "failed");
        const failed = yield* library.subscribe(projectId).pipe(
          Stream.map((snapshot) => snapshot.items[0]!.proxy.status),
          Stream.filter((status) => status === "failed"),
          Stream.runHead,
        );
        assert.equal(Option.getOrUndefined(failed), "failed");

        fake.proxyOutcome = yield* Deferred.make<"succeed" | "cancelled" | "failed">();
        const again = yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        assert.deepEqual(again, { mediaId: "phone", jobId: EngineJobId.make("engine-job-2") });
        assert.equal(fake.proxies.length, 2);

        // A media this server run never imported (as after a restart) is checked on first list.
        const other = writeClip(desktop, "camera.mp4", 6);
        const { sha256, size } = yield* MediaFiles.fingerprint(other);
        const current = yield* edits.read(projectId);
        yield* edits.apply(
          projectId,
          [
            {
              _tag: "putMedia",
              media: {
                id: "camera",
                kind: "video",
                reference: other,
                fingerprint: { sha256, size },
                probe: toEditProbe(videoProbe(other), { num: 30, den: 1 }),
              },
            },
          ],
          { origin: "import", baseRevision: current.revision },
        );
        const started = yield* library.subscribe(projectId).pipe(
          Stream.filter((snapshot) =>
            snapshot.items.some(
              (item) => item.id === "camera" && item.proxy.status === "preparing",
            ),
          ),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(started));
        assert.equal(fake.proxies.at(-1)!.path, other);
        assert.isTrue(NodeFS.existsSync(root));
      }),
    ),
  );

  it.effect("two concurrent re-imports start exactly one proxy job", () =>
    withLibrary(({ projectId, desktop, library, fake }) =>
      Effect.gen(function* () {
        fake.gapSeconds = 10;
        const clip = writeClip(desktop, "phone.mp4", 7);
        yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        yield* Deferred.succeed(fake.proxyOutcome, "failed");
        yield* library.subscribe(projectId).pipe(
          Stream.filter((snapshot) => snapshot.items[0]!.proxy.status === "failed"),
          Stream.runHead,
        );
        fake.proxyOutcome = yield* Deferred.make<"succeed" | "cancelled" | "failed">();
        const results = yield* Effect.forEach(
          [clip, clip, clip],
          (sourcePath) => library.import({ projectId, sourcePath, mode: "reference" }),
          { concurrency: "unbounded" },
        );
        assert.equal(fake.proxies.length, 2);
        assert.deepEqual(
          results.map((result) => result.mediaId),
          ["phone", "phone", "phone"],
        );
        // While it runs, a list does not start another either.
        yield* library.list(projectId);
        assert.equal(fake.proxies.length, 2);
      }),
    ),
  );

  it.effect("/api/assets serves only media recorded in that project's edit.json", () =>
    withLibrary(({ projectId, desktop, library, edits, newProject }) =>
      Effect.gen(function* () {
        const clip = writeClip(desktop, "cam.mp4");
        yield* library.import({ projectId, sourcePath: clip, mode: "reference" });
        const resource = {
          _tag: "project-media" as const,
          projectId,
          mediaId: "cam",
          variant: "original" as const,
        };
        const issued = yield* issueAssetUrl({ resource });
        const [token, name] = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length).split("/");
        assert.deepInclude(yield* resolveAsset(token!, name!), {
          kind: "file",
          path: clip,
          mimeType: "video/mp4",
        });
        const thumbnail = yield* issueAssetUrl({ resource: { ...resource, variant: "thumbnail" } });
        assert.match(thumbnail.relativeUrl, /\.jpg$/u);

        // Another project does not record this media: no URL.
        const other = yield* newProject();
        const refused = yield* issueAssetUrl({ resource: { ...resource, projectId: other } }).pipe(
          Effect.flip,
        );
        assert.equal(refused._tag, "AssetWorkspaceAssetNotFoundError");
        // No proxy was made, so there is none to serve.
        const noProxy = yield* issueAssetUrl({ resource: { ...resource, variant: "proxy" } }).pipe(
          Effect.flip,
        );
        assert.equal(noProxy._tag, "AssetWorkspaceAssetNotFoundError");

        // Removed from edit.json: the issued token stops resolving.
        const snapshot = yield* edits.read(projectId);
        yield* edits.apply(projectId, [{ _tag: "removeMedia", mediaId: "cam" }], {
          origin: "timeline",
          baseRevision: snapshot.revision,
        });
        assert.isNull(yield* resolveAsset(token!, name!));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(issueAssetUrl({ resource }))));
      }),
    ),
  );
});
