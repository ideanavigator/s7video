// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A project's media (S7V-025). Import probes and fingerprints a file, copies it into `assets/` or
 * records where it is, and puts it in `edit.json` through EditDocumentService. Thumbnails and
 * proxies go to the ignored `.s7cache/`; proxy and copy progress live here, never in `edit.json`.
 * The asset route asks `resolveVariant` before it serves a byte, so only recorded media is served.
 */
import {
  EditConflict,
  type EditDocument,
  type EditMedia,
  type EditMediaProbe,
  type EditOp,
  type EditOrigin,
  type EditRational,
  type EngineJobId,
  type MediaAsset,
  type MediaImportInput,
  type MediaImportPlan,
  type MediaImportPlanInput,
  type MediaImportResult,
  MediaLibraryError,
  type MediaLibraryErrorReason,
  type MediaLibrarySnapshot,
  type MediaProbeResult,
  type MediaProxyState,
  type MediaRelinkInput,
  type MediaVariant,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { CACHE_DIR } from "../edit/EditProjectLayout.ts";
import * as EngineService from "../engine/EngineService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as MediaFiles from "./mediaFiles.ts";
import { proxyReasons } from "./ProxyPolicy.ts";

const ASSETS_DIR = "assets";
/** Copy is the default only while this much space stays free after the copy. */
const COPY_FREE_MARGIN_BYTES = 15 * 1024 ** 3;

export interface MediaLibraryOptions {
  /** Tests lower or raise it to reach both defaults without huge files. */
  readonly copyFreeMarginBytes?: number;
}
const THUMBNAIL_WIDTH = 320;
const APPLY_ATTEMPTS = 3;

export interface ResolvedMediaVariant {
  /** The real path the route opens. */
  readonly path: string;
  readonly mimeType: string;
}

export class MediaLibraryService extends Context.Service<
  MediaLibraryService,
  {
    /** The import dialog's default: copy unless the copy would leave less than 15 GB free. */
    readonly plan: (
      input: MediaImportPlanInput,
    ) => Effect.Effect<MediaImportPlan, MediaLibraryError>;
    readonly import: (
      input: MediaImportInput & { readonly origin?: EditOrigin },
    ) => Effect.Effect<MediaImportResult, MediaLibraryError>;
    /** Points a media at a moved original; refused unless the fingerprint matches. */
    readonly relink: (
      input: MediaRelinkInput,
    ) => Effect.Effect<MediaImportResult, MediaLibraryError>;
    readonly list: (projectId: ProjectId) => Effect.Effect<MediaLibrarySnapshot, MediaLibraryError>;
    /** The current list, then a new one after every edit, copy or proxy change. */
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<MediaLibrarySnapshot, MediaLibraryError>;
    /** The file behind one variant of a media recorded in that project's `edit.json`, if any. */
    readonly resolveVariant: (
      projectId: ProjectId,
      mediaId: string,
      variant: MediaVariant,
    ) => Effect.Effect<Option.Option<ResolvedMediaVariant>>;
  }
>()("t3/media/MediaLibraryService") {}

const isEditConflict = Schema.is(EditConflict);

const fail = (reason: MediaLibraryErrorReason, explanation: string) =>
  new MediaLibraryError({ reason, explanation });

const editFailure = (error: EditDocumentService.EditApplyError) =>
  error._tag === "EditUnavailableError" &&
  (error.reason === "not-an-edit-project" || error.reason === "unknown-project")
    ? fail("not-an-edit-project", error.explanation)
    : fail(
        "edit-failed",
        error._tag === "EditUnavailableError" ? error.explanation : "Could not save the edit.",
      );

/** Frames at `from` rounded to the nearest frame at `to`, in integers. */
const rescale = (frames: number, from: EditRational, to: EditRational) =>
  Math.round((frames * to.num * from.den) / (to.den * from.num));

const MEDIA_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

/** `edit.json` keeps the length in document frames and the display size after rotation. */
export const toEditProbe = (probe: MediaProbeResult, documentFps: EditRational): EditMediaProbe => {
  const { video, audio } = probe;
  const turned = video !== null && (video.rotation === 90 || video.rotation === 270);
  const width = video === null ? 0 : turned ? video.height : video.width;
  const height = video === null ? 0 : turned ? video.width : video.height;
  const durationFrames =
    video !== null
      ? rescale(video.durationFrames, video.frameRate, documentFps)
      : audio !== null && audio.durationSamples !== null && audio.sampleRate > 0
        ? rescale(audio.durationSamples, { num: audio.sampleRate, den: 1 }, documentFps)
        : undefined;
  return {
    ...(durationFrames === undefined ? {} : { durationFrames }),
    hasVideo: video !== null,
    hasAudio: audio !== null,
    ...(width > 0 && height > 0 ? { width, height } : {}),
    ...(video === null
      ? {}
      : { fps: video.frameRate, variableFrameRate: video.variableFrameRate, codec: video.codec }),
    ...(audio !== null && audio.sampleRate > 0 ? { sampleRate: audio.sampleRate } : {}),
    ...(audio !== null && audio.channels > 0 ? { audioChannels: audio.channels } : {}),
    ...(video === null && audio !== null ? { codec: audio.codec } : {}),
  };
};

const isStillImage = (probe: MediaProbeResult) =>
  probe.container.includes("image2") ||
  probe.container.endsWith("_pipe") ||
  (probe.video !== null && probe.video.frameCount <= 1 && probe.audio === null);

/** A readable, file-name-safe id from the file name, unique in the document. */
export const mediaIdFor = (fileName: string, taken: ReadonlySet<string>) => {
  const stem = fileName.replace(/\.[^.]*$/u, "");
  const slug =
    stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^[^a-z0-9]+/u, "")
      .replace(/[-.]+$/u, "")
      .slice(0, 48) || "clip";
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${slug}-${suffix}`)) return `${slug}-${suffix}`;
  }
};

interface ProxyRun {
  readonly status: "preparing" | "failed";
  readonly jobId?: EngineJobId;
  readonly progress?: number;
}

const make = Effect.fn("MediaLibraryService.make")(function* (options: MediaLibraryOptions) {
  const copyFreeMarginBytes = options.copyFreeMarginBytes ?? COPY_FREE_MARGIN_BYTES;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const edits = yield* EditDocumentService.EditDocumentService;
  const engine = yield* EngineService.EngineService;
  const projects = yield* ProjectService.ProjectService;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  // Copy progress arrives in a Node stream callback, outside any fiber.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const changes = yield* PubSub.unbounded<ProjectId>();
  const notify = (projectId: ProjectId) => PubSub.publish(changes, projectId);
  /** Copies in flight, per project. */
  const importing = new Map<ProjectId, Map<string, { label: string; progress: number }>>();
  /** Proxy jobs by `${projectId}\0${sha256}`; a finished proxy is its file in `.s7cache/`. */
  const proxyRuns = new Map<string, ProxyRun>();
  const proxyJobs = new Map<EngineJobId, { key: string; projectId: ProjectId }>();

  yield* engine.subscribeJobs.pipe(
    Stream.runForEach((event) => {
      if (event.type !== "updated" || event.job.state !== "running") return Effect.void;
      const owner = proxyJobs.get(event.job.id);
      const run = owner && proxyRuns.get(owner.key);
      if (!owner || run?.status !== "preparing") return Effect.void;
      proxyRuns.set(owner.key, { ...run, progress: event.job.progress });
      return notify(owner.projectId);
    }),
    Effect.forkScoped,
  );

  const projectRoot = Effect.fnUntraced(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(() => fail("edit-failed", "Could not look up this project.")));
    if (Option.isNone(project)) {
      return yield* fail("not-an-edit-project", "This project no longer exists.");
    }
    return yield* fileSystem
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.mapError(() => fail("not-found", "The project folder is missing.")));
  });

  const readDocument = (projectId: ProjectId) =>
    edits.read(projectId).pipe(Effect.mapError(editFailure));

  /** Applies ops built from the current document, retrying when another change lands first. */
  const applyWith = Effect.fnUntraced(function* (
    projectId: ProjectId,
    origin: EditOrigin,
    build: (document: EditDocument) => ReadonlyArray<EditOp>,
  ) {
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = yield* readDocument(projectId);
      const result = yield* edits
        .apply(projectId, build(snapshot.document), { origin, baseRevision: snapshot.revision })
        .pipe(
          Effect.asSome,
          Effect.catchIf(
            (error) => isEditConflict(error) && attempt < APPLY_ATTEMPTS,
            () => Effect.succeedNone,
          ),
          Effect.mapError(editFailure),
        );
      if (Option.isSome(result)) return result.value;
    }
  });

  const cachePaths = (root: string, sha256: string) => ({
    thumbnail: path.join(root, CACHE_DIR, "thumbs", `${sha256}.jpg`),
    proxy: path.join(root, CACHE_DIR, "proxies", `${sha256}.mp4`),
  });

  const originalPath = (root: string, media: EditMedia) =>
    media.path !== undefined ? path.resolve(root, media.path) : media.reference;

  const isFile = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Option.some(info) : Option.none())),
      Effect.orElseSucceed(() => Option.none<FileSystem.File.Info>()),
    );

  /** Present when the file is there and still its recorded size. */
  const isPresent = Effect.fnUntraced(function* (root: string, media: EditMedia) {
    const file = originalPath(root, media);
    if (file === undefined) return false;
    const info = yield* isFile(file);
    return Option.isSome(info) && Number(info.value.size) === media.fingerprint.size;
  });

  const proxyState = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    sha256: string,
  ) {
    const run = proxyRuns.get(`${projectId}\0${sha256}`);
    if (run !== undefined) {
      return {
        status: run.status,
        ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
        ...(run.progress === undefined ? {} : { progress: run.progress }),
      } satisfies MediaProxyState;
    }
    const ready = Option.isSome(yield* isFile(cachePaths(root, sha256).proxy));
    return { status: ready ? "ready" : "none" } satisfies MediaProxyState;
  });

  const assetOf = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    documentFps: EditRational,
    media: EditMedia,
  ) {
    const { probe } = media;
    const durationFrames =
      probe.durationFrames === undefined
        ? undefined
        : probe.fps === undefined
          ? probe.durationFrames
          : rescale(probe.durationFrames, documentFps, probe.fps);
    const cache = cachePaths(root, media.fingerprint.sha256);
    return {
      id: media.id,
      kind: media.kind,
      label: media.label ?? media.id,
      storage: media.path !== undefined ? "copy" : "reference",
      location: media.path ?? media.reference ?? "",
      state: (yield* isPresent(root, media)) ? "ready" : "missing",
      sizeBytes: media.fingerprint.size,
      ...(durationFrames === undefined ? {} : { durationFrames }),
      ...(probe.fps === undefined ? {} : { fps: probe.fps }),
      ...(probe.width === undefined ? {} : { width: probe.width }),
      ...(probe.height === undefined ? {} : { height: probe.height }),
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      hasThumbnail: Option.isSome(yield* isFile(cache.thumbnail)),
      proxy: yield* proxyState(projectId, root, media.fingerprint.sha256),
    } satisfies MediaAsset;
  });

  const snapshotOf = Effect.fnUntraced(function* (projectId: ProjectId, document: EditDocument) {
    const root = yield* projectRoot(projectId);
    const items = yield* Effect.forEach(document.media, (media) =>
      assetOf(projectId, root, document.fps, media),
    );
    return {
      projectId,
      fps: document.fps,
      items,
      importing: [...(importing.get(projectId) ?? new Map()).entries()].map(([key, entry]) => ({
        key,
        ...entry,
      })),
    } satisfies MediaLibrarySnapshot;
  });

  const list: MediaLibraryService["Service"]["list"] = Effect.fn("MediaLibraryService.list")(
    function* (projectId) {
      return yield* snapshotOf(projectId, (yield* readDocument(projectId)).document);
    },
  );

  const subscribe: MediaLibraryService["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read, so no change in between is lost.
        const ours = Stream.fromSubscription(yield* PubSub.subscribe(changes)).pipe(
          Stream.filter((changed) => changed === projectId),
        );
        const editChanges = edits.subscribe(projectId).pipe(Stream.mapError(editFailure));
        return Stream.merge(editChanges.pipe(Stream.map(() => undefined)), ours).pipe(
          Stream.mapEffect(() => list(projectId)),
        );
      }),
    );

  const setImporting = (projectId: ProjectId, key: string, label: string, progress: number) =>
    Effect.suspend(() => {
      const entries = importing.get(projectId) ?? new Map();
      entries.set(key, { label, progress });
      importing.set(projectId, entries);
      return notify(projectId);
    });

  const clearImporting = (projectId: ProjectId, key: string) =>
    Effect.suspend(() => {
      importing.get(projectId)?.delete(key);
      return notify(projectId);
    });

  /** Clone when the volume allows it; otherwise a streamed copy with progress in the list. */
  const copyIntoAssets = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    source: string,
    mediaId: string,
    label: string,
  ) {
    const assets = path.join(root, ASSETS_DIR);
    yield* fileSystem.makeDirectory(assets, { recursive: true }).pipe(Effect.ignore);
    const relative = `${ASSETS_DIR}/${mediaId}${path.extname(source).toLowerCase()}`;
    const target = path.join(root, relative);
    const unique = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(() =>
          fail("copy-failed", "The file could not be copied into the project."),
        ),
      );
    const partial = path.join(assets, `.${mediaId}.${unique}.part`);
    const key = `copy-${mediaId}`;
    const copied = Effect.gen(function* () {
      const cloned =
        (yield* MediaFiles.canClone(source, assets, platform)) &&
        Option.isSome(yield* MediaFiles.cloneFile(source, partial).pipe(Effect.option));
      if (!cloned) {
        yield* fileSystem.remove(partial, { force: true }).pipe(Effect.ignore);
        yield* setImporting(projectId, key, label, 0);
        yield* MediaFiles.streamCopy(source, partial, (progress) => {
          runFork(setImporting(projectId, key, label, progress));
        });
      }
      yield* fileSystem.rename(partial, target);
    });
    yield* copied.pipe(
      Effect.onExit(() => clearImporting(projectId, key)),
      Effect.onError(() => fileSystem.remove(partial, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(() =>
        fail("copy-failed", "The file could not be copied into the project. Nothing was changed."),
      ),
    );
    return relative;
  });

  const thumbnailFor = Effect.fnUntraced(function* (
    root: string,
    source: string,
    sha256: string,
    probe: MediaProbeResult,
  ) {
    const video = probe.video;
    if (video === null) return;
    const output = cachePaths(root, sha256).thumbnail;
    if (Option.isSome(yield* isFile(output))) return;
    // About one second in, past fade-ins and black first frames.
    const oneSecond = Math.ceil(video.frameRate.num / video.frameRate.den);
    const frame = Math.max(0, Math.min(video.durationFrames - 1, oneSecond));
    yield* engine
      .thumbnail({
        path: source,
        outputPath: output,
        frame,
        rate: video.frameRate,
        maxWidth: THUMBNAIL_WIDTH,
      })
      .pipe(Effect.ignore);
  });

  /** Starts a background proxy when the policy asks for one; returns its job id. */
  const startProxy = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    source: string,
    sha256: string,
    probe: MediaProbeResult,
  ) {
    const video = probe.video;
    const key = `${projectId}\0${sha256}`;
    if (video === null || video.durationFrames < 1 || proxyRuns.get(key)?.status === "preparing") {
      return undefined;
    }
    const output = cachePaths(root, sha256).proxy;
    if (Option.isSome(yield* isFile(output))) return undefined;
    const keyframes = yield* engine.keyframes({ path: source }).pipe(Effect.option);
    const reasons = proxyReasons({ probe, keyframes: Option.getOrUndefined(keyframes) });
    if (reasons.length === 0) return undefined;
    yield* Effect.logInfo("making a preview proxy", { reasons });
    // Settles with the job id, or with nothing when the engine failed before the job began.
    const started = yield* Deferred.make<EngineJobId | undefined>();
    proxyRuns.set(key, { status: "preparing" });
    const color = Object.fromEntries(
      Object.entries(video.color).filter(([, value]) => value !== null),
    );
    yield* engine
      .proxy({
        projectId,
        path: source,
        outputPath: output,
        rate: video.frameRate,
        timeBase: video.timeBase,
        durationFrames: video.durationFrames,
        color,
        onStart: (jobId) =>
          Effect.suspend(() => {
            proxyRuns.set(key, { status: "preparing", jobId, progress: 0 });
            proxyJobs.set(jobId, { key, projectId });
            return Deferred.succeed(started, jobId).pipe(Effect.andThen(notify(projectId)));
          }),
      })
      .pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.suspend(() => {
            const jobId = proxyRuns.get(key)?.jobId;
            if (jobId !== undefined) proxyJobs.delete(jobId);
            // A cancelled proxy is simply not there; a failed one says so in the list.
            const cancelled =
              exit._tag === "Failure" &&
              (Cause.hasInterrupts(exit.cause) ||
                exit.cause.reasons.some(
                  (reason) => Cause.isFailReason(reason) && reason.error.reason === "cancelled",
                ));
            if (exit._tag === "Success" || cancelled) proxyRuns.delete(key);
            else proxyRuns.set(key, { status: "failed" });
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(notify(projectId)));
          }),
        ),
        Effect.forkIn(serviceScope),
      );
    return yield* Deferred.await(started);
  });

  const sourceFile = Effect.fnUntraced(function* (sourcePath: string) {
    if (!path.isAbsolute(sourcePath)) {
      return yield* fail("not-found", "Give the file's full path.");
    }
    const real = yield* fileSystem
      .realPath(sourcePath)
      .pipe(Effect.mapError(() => fail("not-found", "That file was not found.")));
    const info = yield* isFile(real);
    if (Option.isNone(info)) return yield* fail("not-a-media-file", "That is not a file.");
    return { real, size: Number(info.value.size) };
  });

  const probeSource = Effect.fnUntraced(function* (source: string) {
    const probe = yield* engine
      .probe({ path: source })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "rpc_error"
            ? fail("unreadable", "s7video could not read this file as video or audio.")
            : fail("unreadable", error.message),
        ),
      );
    if (isStillImage(probe)) {
      return yield* fail("not-a-media-file", "Only video and audio files can be imported.");
    }
    return probe;
  });

  const plan: MediaLibraryService["Service"]["plan"] = Effect.fn("MediaLibraryService.plan")(
    function* (input) {
      const root = yield* projectRoot(input.projectId);
      const sizes = yield* Effect.forEach(input.sourcePaths, (source) =>
        sourceFile(source).pipe(Effect.map((file) => file.size)),
      );
      const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
      const freeBytes = yield* MediaFiles.freeBytes(path.join(root, ASSETS_DIR)).pipe(
        Effect.catch(() => MediaFiles.freeBytes(root)),
        Effect.orElseSucceed(() => 0),
      );
      if (freeBytes >= totalBytes + copyFreeMarginBytes) {
        return { suggestedMode: "copy", totalBytes, freeBytes } satisfies MediaImportPlan;
      }
      const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
      return {
        suggestedMode: "reference",
        reason: `A copy needs ${gb(totalBytes)} and should leave ${gb(copyFreeMarginBytes)} free, but this Mac has ${gb(freeBytes)} free. s7video will use the file where it is.`,
        totalBytes,
        freeBytes,
      } satisfies MediaImportPlan;
    },
  );

  const importMedia: MediaLibraryService["Service"]["import"] = Effect.fn(
    "MediaLibraryService.import",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ mode: input.mode });
    const root = yield* projectRoot(input.projectId);
    const before = yield* readDocument(input.projectId);
    const { real } = yield* sourceFile(input.sourcePath);
    const probe = yield* probeSource(real);
    const fingerprint = yield* MediaFiles.fingerprint(real).pipe(
      Effect.mapError(() => fail("unreadable", "The file could not be read.")),
    );
    const existing = before.document.media.find(
      (media) =>
        media.fingerprint.sha256 === fingerprint.sha256 &&
        media.fingerprint.size === fingerprint.size,
    );
    if (existing !== undefined && (yield* isPresent(root, existing))) {
      return { mediaId: existing.id };
    }
    const label = path.basename(real);
    const mediaId =
      existing?.id ?? mediaIdFor(label, new Set(before.document.media.map((media) => media.id)));
    const assets = path.join(root, ASSETS_DIR);
    // Already in the project's own assets/ folder: record it where it is, copy nothing.
    const inAssets = real.startsWith(assets + path.sep);
    const location: Pick<EditMedia, "path" | "reference"> = inAssets
      ? { path: path.relative(root, real).split(path.sep).join("/") }
      : input.mode === "copy"
        ? { path: yield* copyIntoAssets(input.projectId, root, real, mediaId, label) }
        : { reference: real };
    yield* thumbnailFor(root, real, fingerprint.sha256, probe);
    const media: EditMedia = {
      id: mediaId,
      kind: probe.video !== null ? "video" : "audio",
      ...location,
      fingerprint,
      probe: toEditProbe(probe, before.document.fps),
      label,
    };
    yield* applyWith(input.projectId, input.origin ?? "import", () => [
      { _tag: "putMedia", media },
    ]).pipe(
      Effect.tapError(() =>
        location.path !== undefined && !inAssets
          ? fileSystem.remove(path.join(root, location.path), { force: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    // Proxies read the project's copy when there is one, so a moved original cannot break them.
    const readable = location.path !== undefined ? path.join(root, location.path) : real;
    const jobId = yield* startProxy(input.projectId, root, readable, fingerprint.sha256, probe);
    return { mediaId, ...(jobId === undefined ? {} : { jobId }) } satisfies MediaImportResult;
  });

  const relink: MediaLibraryService["Service"]["relink"] = Effect.fn("MediaLibraryService.relink")(
    function* (input) {
      const before = yield* readDocument(input.projectId);
      const media = before.document.media.find((entry) => entry.id === input.mediaId);
      if (media === undefined) {
        return yield* fail("unknown-media", "That clip is not in this project.");
      }
      const { real } = yield* sourceFile(input.sourcePath);
      const fingerprint = yield* MediaFiles.fingerprint(real).pipe(
        Effect.mapError(() => fail("unreadable", "The file could not be read.")),
      );
      if (
        fingerprint.sha256 !== media.fingerprint.sha256 ||
        fingerprint.size !== media.fingerprint.size
      ) {
        return yield* fail(
          "different-file",
          "That file is not the original clip, so it was not linked. Pick the moved original.",
        );
      }
      const relinked: EditMedia = {
        id: media.id,
        kind: media.kind,
        reference: real,
        fingerprint: media.fingerprint,
        probe: media.probe,
        ...(media.label === undefined ? {} : { label: media.label }),
        ...(media.metadata === undefined ? {} : { metadata: media.metadata }),
      };
      yield* applyWith(input.projectId, "import", () => [{ _tag: "putMedia", media: relinked }]);
      return { mediaId: media.id };
    },
  );

  const resolveVariant: MediaLibraryService["Service"]["resolveVariant"] = Effect.fn(
    "MediaLibraryService.resolveVariant",
  )(function* (projectId, mediaId, variant) {
    const none = Option.none<ResolvedMediaVariant>();
    const snapshot = yield* edits.read(projectId).pipe(Effect.option);
    if (Option.isNone(snapshot)) return none;
    const media = snapshot.value.document.media.find((entry) => entry.id === mediaId);
    const root = yield* projectRoot(projectId).pipe(Effect.option);
    if (media === undefined || Option.isNone(root)) return none;
    const cache = cachePaths(root.value, media.fingerprint.sha256);
    const candidate =
      variant === "original"
        ? originalPath(root.value, media)
        : variant === "proxy"
          ? cache.proxy
          : variant === "thumbnail"
            ? cache.thumbnail
            : undefined;
    if (candidate === undefined) return none;
    const real = yield* fileSystem.realPath(candidate).pipe(Effect.option);
    if (Option.isNone(real)) return none;
    // A recorded copy must stay inside the project, whatever symlinks say.
    if (
      variant === "original" &&
      media.path !== undefined &&
      !real.value.startsWith(root.value + path.sep)
    ) {
      return none;
    }
    const mimeType =
      variant === "thumbnail"
        ? "image/jpeg"
        : variant === "proxy"
          ? "video/mp4"
          : MEDIA_MIME_TYPES[path.extname(real.value).toLowerCase()];
    return mimeType === undefined ? none : Option.some({ path: real.value, mimeType });
  });

  return MediaLibraryService.of({
    plan,
    import: importMedia,
    relink,
    list,
    subscribe,
    resolveVariant,
  });
});

export const layerWith = (options: MediaLibraryOptions) =>
  Layer.effect(MediaLibraryService, make(options));

export const layer = layerWith({});
