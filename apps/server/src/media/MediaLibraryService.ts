// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A project's media (S7V-025): import puts a file in `edit.json` (copied or by reference).
 * Thumbnails, proxies, waveforms and filmstrips go to the ignored `.s7cache/` by sha256; job and
 * copy progress live here, never in `edit.json`. The asset route asks `resolveVariant` before
 * it serves a byte, so only recorded media is served.
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
  type MediaDataPart,
  type MediaDataPartName,
  type MediaDataState,
  MediaFilmstripIndex,
  MediaPeaksIndex,
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
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { allIds } from "../edit/applyEditOps.ts";
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
    /** `label` names a file stored under another name (a chat attachment's id). */
    readonly import: (
      input: MediaImportInput & { readonly origin?: EditOrigin; readonly label?: string },
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
    /**
     * The file behind one variant of a media recorded in that project's `edit.json`, if any.
     * `peaks` and `filmstrip` need a `part` (one file of many); the other variants refuse one.
     */
    readonly resolveVariant: (
      projectId: ProjectId,
      mediaId: string,
      variant: MediaVariant,
      part?: MediaDataPartName,
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

const decodePeaksIndex = Schema.decodeUnknownOption(Schema.fromJsonString(MediaPeaksIndex));
const decodeFilmstripIndex = Schema.decodeUnknownOption(Schema.fromJsonString(MediaFilmstripIndex));
const MEDIA_DATA_INDEX = "index.json";

/** The file a `part` names inside its variant's folder (`MediaDataPartName`). */
const mediaDataFile = (variant: "peaks" | "filmstrip", part: string) => {
  if (part === "index") return MEDIA_DATA_INDEX;
  if (variant === "peaks" && /^p[1-9][0-9]*$/u.test(part)) return `${part.slice(1)}.f32`;
  if (variant === "filmstrip" && /^f[1-9][0-9]*s-[1-9][0-9]*$/u.test(part)) {
    return `${part.slice(1)}.jpg`;
  }
  return undefined;
};

interface MediaDataRun {
  readonly status: "preparing" | "failed";
  readonly jobId?: EngineJobId;
  readonly progress?: number;
}

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
  /** Media whose proxy is being decided or made right now; one at a time per media. */
  const proxyClaims = new Set<string>();
  /** Media whose proxy need this server run has already judged. */
  const proxyChecked = new Set<string>();

  /** Media-data jobs by the same key; finished data is its index files in `.s7cache/`. */
  const mediaDataRuns = new Map<string, MediaDataRun>();
  const mediaDataJobs = new Map<EngineJobId, { key: string; projectId: ProjectId }>();
  const mediaDataClaims = new Set<string>();
  const mediaDataChecked = new Set<string>();

  yield* engine.subscribeJobs.pipe(
    Stream.runForEach((event) => {
      if (event.type !== "updated" || event.job.state !== "running") return Effect.void;
      const data = mediaDataJobs.get(event.job.id);
      const dataRun = data && mediaDataRuns.get(data.key);
      if (data && dataRun?.status === "preparing") {
        mediaDataRuns.set(data.key, { ...dataRun, progress: event.job.progress });
        return notify(data.projectId);
      }
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
    /** Folders: `index.json` plus one file per level or sheet, written by the engine. */
    peaks: path.join(root, CACHE_DIR, "peaks", sha256),
    filmstrip: path.join(root, CACHE_DIR, "filmstrip", sha256),
  });

  const originalPath = (root: string, media: EditMedia) =>
    media.path !== undefined ? path.resolve(root, media.path) : media.reference;

  const isFile = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Option.some(info) : Option.none())),
      Effect.orElseSucceed(() => Option.none<FileSystem.File.Info>()),
    );

  /** Fingerprints by file, valid while its size, mtime and inode stay the same. */
  const fingerprints = new Map<string, { readonly stamp: string; readonly sha256: string }>();

  /**
   * Present when the file is there with the recorded fingerprint: a different file at the same
   * path (a re-import, an undo to an older entry) is missing, not silently the wrong bytes.
   */
  const isPresent = Effect.fnUntraced(function* (root: string, media: EditMedia) {
    const file = originalPath(root, media);
    if (file === undefined) return false;
    const info = yield* isFile(file);
    if (Option.isNone(info) || Number(info.value.size) !== media.fingerprint.size) return false;
    const stamp = [
      info.value.size,
      Option.getOrUndefined(info.value.mtime)?.getTime(),
      Option.getOrUndefined(info.value.ino),
    ].join(":");
    let known = fingerprints.get(file);
    if (known?.stamp !== stamp) {
      const measured = yield* MediaFiles.fingerprint(file).pipe(Effect.option);
      if (Option.isNone(measured)) return false;
      known = { stamp, sha256: measured.value.sha256 };
      fingerprints.set(file, known);
    }
    return known.sha256 === media.fingerprint.sha256;
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

  /** Whether a finished index of the current version is there; it is written last. */
  const mediaDataReady = Effect.fnUntraced(function* (
    root: string,
    sha256: string,
    variant: "peaks" | "filmstrip",
  ) {
    const file = path.join(cachePaths(root, sha256)[variant], MEDIA_DATA_INDEX);
    const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return false;
    return variant === "peaks"
      ? Option.isSome(decodePeaksIndex(text.value))
      : Option.isSome(decodeFilmstripIndex(text.value));
  });

  /** Which media data this media can have at all: no sound has no waveform, no picture no strip. */
  const mediaDataWants = (media: Pick<EditMedia, "kind" | "probe">) => ({
    peaks: media.probe.hasAudio,
    filmstrip: media.kind === "video" && media.probe.hasVideo && media.probe.fps !== undefined,
  });

  const mediaDataState = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    media: EditMedia,
  ) {
    const sha256 = media.fingerprint.sha256;
    const wants = mediaDataWants(media);
    const part = (wanted: boolean, ready: boolean): MediaDataPart =>
      !wanted ? "none" : ready ? "ready" : "pending";
    const peaks = part(wants.peaks, wants.peaks && (yield* mediaDataReady(root, sha256, "peaks")));
    const filmstrip = part(
      wants.filmstrip,
      wants.filmstrip && (yield* mediaDataReady(root, sha256, "filmstrip")),
    );
    const run = mediaDataRuns.get(`${projectId}\0${sha256}`);
    if (run !== undefined) {
      return {
        status: run.status,
        ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
        ...(run.progress === undefined ? {} : { progress: run.progress }),
        peaks,
        filmstrip,
      } satisfies MediaDataState;
    }
    const pending = peaks === "pending" || filmstrip === "pending";
    const status = pending || (peaks === "none" && filmstrip === "none") ? "none" : "ready";
    return { status, peaks, filmstrip } satisfies MediaDataState;
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
      mediaData: yield* mediaDataState(projectId, root, media),
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

  /**
   * The first time a server run lists a video, it checks for a proxy the policy wants but nobody
   * made (a failure, or a job cut short when the app quit) and starts it in the background.
   */
  const ensureProxy = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    media: EditMedia,
  ) {
    const key = `${projectId}\0${media.fingerprint.sha256}`;
    if (media.kind !== "video" || proxyChecked.has(key)) return;
    proxyChecked.add(key);
    const source = originalPath(root, media);
    if (source === undefined || !(yield* isPresent(root, media))) {
      proxyChecked.delete(key);
      return;
    }
    const probe = yield* engine.probe({ path: source }).pipe(Effect.option);
    if (Option.isSome(probe)) {
      yield* startProxy(projectId, root, source, media.fingerprint.sha256, probe.value);
    }
  });

  /** Media from before S7V-035, or whose job was cut short, get their data on the first list. */
  const ensureMediaData = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    media: EditMedia,
  ) {
    const key = `${projectId}\0${media.fingerprint.sha256}`;
    if (mediaDataChecked.has(key)) return;
    mediaDataChecked.add(key);
    const source = originalPath(root, media);
    if (source === undefined || !(yield* isPresent(root, media))) {
      mediaDataChecked.delete(key);
      return;
    }
    yield* startMediaData(projectId, root, source, media);
  });

  const list: MediaLibraryService["Service"]["list"] = Effect.fn("MediaLibraryService.list")(
    function* (projectId) {
      const { document } = yield* readDocument(projectId);
      const snapshot = yield* snapshotOf(projectId, document);
      const root = yield* projectRoot(projectId);
      yield* Effect.forEach(
        document.media,
        (media) =>
          ensureProxy(projectId, root, media).pipe(
            Effect.andThen(ensureMediaData(projectId, root, media)),
          ),
        { discard: true },
      ).pipe(Effect.ignore, Effect.forkIn(serviceScope));
      return snapshot;
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
    label: string,
  ) {
    const assets = path.join(root, ASSETS_DIR);
    yield* fileSystem.makeDirectory(assets, { recursive: true }).pipe(Effect.ignore);
    const stem = mediaIdFor(label, new Set());
    const unique = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(() =>
          fail("copy-failed", "The file could not be copied into the project."),
        ),
      );
    const partial = path.join(assets, `.${stem}.${unique}.part`);
    const key = `copy-${unique}`;
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
      // Never replaces a file already in assets/: the name moves on to the next free one.
      return yield* MediaFiles.publishExclusive(
        partial,
        assets,
        stem,
        path.extname(source).toLowerCase(),
      );
    });
    const name = yield* copied.pipe(
      Effect.onExit(() => clearImporting(projectId, key)),
      Effect.onError(() => fileSystem.remove(partial, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(() =>
        fail("copy-failed", "The file could not be copied into the project. Nothing was changed."),
      ),
    );
    return `${ASSETS_DIR}/${name}`;
  });

  const thumbnailFor = Effect.fnUntraced(function* (
    root: string,
    source: string,
    sha256: string,
    probe: MediaProbeResult,
  ) {
    const video = probe.video;
    if (video === null) return false;
    const output = cachePaths(root, sha256).thumbnail;
    if (Option.isSome(yield* isFile(output))) return false;
    // About one second in, past fade-ins and black first frames.
    const oneSecond = Math.ceil(video.frameRate.num / video.frameRate.den);
    const frame = Math.max(0, Math.min(video.durationFrames - 1, oneSecond));
    return yield* engine
      .thumbnail({
        path: source,
        outputPath: output,
        frame,
        rate: video.frameRate,
        maxWidth: THUMBNAIL_WIDTH,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
  });

  /**
   * Makes a missing thumbnail and republishes the list, in the service scope: an import cut short
   * after its edit landed (app quit, closed RPC, stopped tool) still gets its thumbnail.
   */
  const thumbnailInBackground = (
    projectId: ProjectId,
    root: string,
    source: string,
    sha256: string,
    probe: MediaProbeResult,
  ) =>
    thumbnailFor(root, source, sha256, probe).pipe(
      Effect.flatMap((made) => (made ? notify(projectId) : Effect.void)),
      Effect.forkIn(serviceScope),
      Effect.flatMap(Fiber.join),
    );

  /** Starts a background proxy when the policy asks for one; returns its job id. */
  const startProxy = (
    projectId: ProjectId,
    root: string,
    source: string,
    sha256: string,
    probe: MediaProbeResult,
  ) =>
    Effect.suspend(() => {
      const key = `${projectId}\0${sha256}`;
      // Claimed before anything waits, so concurrent callers (two re-imports, a re-import and a
      // first list) cannot both start a proxy; the claim lasts until that job ends.
      if (probe.video === null || probe.video.durationFrames < 1 || proxyClaims.has(key)) {
        return Effect.succeed(proxyRuns.get(key)?.jobId);
      }
      proxyClaims.add(key);
      const job = { forked: false };
      return decideProxy(projectId, root, source, sha256, probe, key, job).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            if (!job.forked) proxyClaims.delete(key);
          }),
        ),
      );
    });

  const decideProxy = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    source: string,
    sha256: string,
    probe: MediaProbeResult,
    key: string,
    job: { forked: boolean },
  ) {
    const video = probe.video!;
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
            proxyClaims.delete(key);
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(notify(projectId)));
          }),
        ),
        Effect.forkIn(serviceScope),
      );
    job.forked = true;
    return yield* Deferred.await(started);
  });

  /**
   * Starts the waveform and filmstrip job in the background when either is missing; a finished
   * index for this fingerprint is reused and starts no decode. One job per media at a time.
   * The filmstrip reads the proxy when there is one (frame N of the proxy is frame N).
   */
  const startMediaData = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    source: string,
    media: Pick<EditMedia, "kind" | "probe" | "fingerprint">,
  ) {
    const sha256 = media.fingerprint.sha256;
    const key = `${projectId}\0${sha256}`;
    if (mediaDataClaims.has(key)) return;
    mediaDataClaims.add(key);
    const wants = mediaDataWants(media);
    const cache = cachePaths(root, sha256);
    const peaks = wants.peaks && !(yield* mediaDataReady(root, sha256, "peaks"));
    const fps = media.probe.fps;
    const filmstrip =
      wants.filmstrip && fps !== undefined && !(yield* mediaDataReady(root, sha256, "filmstrip"));
    if (!peaks && !filmstrip) {
      mediaDataClaims.delete(key);
      return;
    }
    const pictures = Option.isSome(yield* isFile(cache.proxy)) ? cache.proxy : source;
    // Settles once the job has its id (or failed before it began), so the caller sees it listed.
    const started = yield* Deferred.make<void>();
    mediaDataRuns.set(key, { status: "preparing", progress: 0 });
    yield* engine
      .mediaData({
        projectId,
        ...(peaks ? { peaks: { path: source, outputDir: cache.peaks } } : {}),
        ...(filmstrip && fps !== undefined
          ? { filmstrip: { path: pictures, outputDir: cache.filmstrip, rate: fps } }
          : {}),
        onStart: (jobId) =>
          Effect.suspend(() => {
            mediaDataRuns.set(key, { status: "preparing", jobId, progress: 0 });
            mediaDataJobs.set(jobId, { key, projectId });
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(notify(projectId)));
          }),
        onStep: () => notify(projectId),
      })
      .pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.suspend(() => {
            const jobId = mediaDataRuns.get(key)?.jobId;
            if (jobId !== undefined) mediaDataJobs.delete(jobId);
            const cancelled =
              exit._tag === "Failure" &&
              (Cause.hasInterrupts(exit.cause) ||
                exit.cause.reasons.some(
                  (reason) => Cause.isFailReason(reason) && reason.error.reason === "cancelled",
                ));
            if (exit._tag === "Success" || cancelled) mediaDataRuns.delete(key);
            else mediaDataRuns.set(key, { status: "failed" });
            mediaDataClaims.delete(key);
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(notify(projectId)));
          }),
        ),
        Effect.forkIn(serviceScope),
      );
    yield* Deferred.await(started);
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
      // Importing again retries a thumbnail or proxy that failed or was cut short.
      proxyChecked.add(`${input.projectId}\0${fingerprint.sha256}`);
      const source = originalPath(root, existing) ?? real;
      mediaDataChecked.add(`${input.projectId}\0${fingerprint.sha256}`);
      const [, retried] = yield* Effect.all(
        [
          thumbnailInBackground(input.projectId, root, source, fingerprint.sha256, probe),
          startProxy(input.projectId, root, source, fingerprint.sha256, probe),
        ],
        { concurrency: 2 },
      );
      yield* startMediaData(input.projectId, root, source, existing);
      return { mediaId: existing.id, ...(retried === undefined ? {} : { jobId: retried }) };
    }
    const label =
      input.label === undefined || input.label.trim() === ""
        ? path.basename(real)
        : path.basename(input.label.trim());
    const assets = path.join(root, ASSETS_DIR);
    // Already in the project's own assets/ folder: record it where it is, copy nothing.
    const inAssets = real.startsWith(assets + path.sep);
    const location: Pick<EditMedia, "path" | "reference"> = inAssets
      ? { path: path.relative(root, real).split(path.sep).join("/") }
      : input.mode === "copy"
        ? { path: yield* copyIntoAssets(input.projectId, root, real, label) }
        : { reference: real };
    const media: Omit<EditMedia, "id"> = {
      kind: probe.video !== null ? "video" : "audio",
      ...location,
      fingerprint,
      probe: toEditProbe(probe, before.document.fps),
      label,
    };
    // The id is chosen against the document the edit lands on, so two imports of files with the
    // same name at once get two ids rather than one replacing the other.
    let mediaId = "";
    // Marked before the edit lands: the list that edit triggers must not probe the file again.
    proxyChecked.add(`${input.projectId}\0${fingerprint.sha256}`);
    mediaDataChecked.add(`${input.projectId}\0${fingerprint.sha256}`);
    yield* applyWith(input.projectId, input.origin ?? "import", (document) => {
      mediaId = existing?.id ?? mediaIdFor(label, allIds(document));
      return [{ _tag: "putMedia", media: { id: mediaId, ...media } }];
    }).pipe(
      Effect.tapError(() =>
        location.path !== undefined && !inAssets
          ? fileSystem.remove(path.join(root, location.path), { force: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    // The row is in the list already. Its thumbnail (a 4K decode on big clips) and the proxy
    // decision (a keyframe scan) run side by side in the engine's workers.
    // Proxies read the project's copy when there is one, so a moved original cannot break them.
    const readable = location.path !== undefined ? path.join(root, location.path) : real;
    const [, jobId] = yield* Effect.all(
      [
        thumbnailInBackground(input.projectId, root, real, fingerprint.sha256, probe),
        startProxy(input.projectId, root, readable, fingerprint.sha256, probe),
      ],
      { concurrency: 2 },
    );
    yield* startMediaData(input.projectId, root, readable, media);
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
  )(function* (projectId, mediaId, variant, part) {
    const none = Option.none<ResolvedMediaVariant>();
    const isData = variant === "peaks" || variant === "filmstrip";
    if (isData !== (part !== undefined)) return none;
    const dataFile = isData && part !== undefined ? mediaDataFile(variant, part) : undefined;
    if (isData && dataFile === undefined) return none;
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
            : isData && dataFile !== undefined
              ? path.join(cache[variant], dataFile)
              : undefined;
    if (candidate === undefined) return none;
    const real = yield* fileSystem.realPath(candidate).pipe(Effect.option);
    if (Option.isNone(real)) return none;
    // A recorded copy must stay inside the project, and cache files inside its .s7cache/,
    // whatever symlinks say.
    const mustBeUnder =
      variant === "original"
        ? media.path === undefined
          ? undefined
          : root.value
        : isData
          ? cache[variant]
          : path.join(root.value, CACHE_DIR);
    if (mustBeUnder !== undefined && !real.value.startsWith(mustBeUnder + path.sep)) return none;
    const mimeType =
      variant === "thumbnail" || dataFile?.endsWith(".jpg")
        ? "image/jpeg"
        : dataFile === MEDIA_DATA_INDEX
          ? "application/json"
          : dataFile?.endsWith(".f32")
            ? "application/octet-stream"
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
