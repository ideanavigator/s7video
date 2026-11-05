// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - os.totalmem() picks the light model on 8 GB Macs.
// Built-in transcription (S7V-026, ADR-006): transcribe a project's media through the engine,
// read the cached transcript, and the speech model's status, download and the one-time question.
// The agent tools (`video_transcribe`, `video_transcript_read`) and the Editor panel call these
// methods; the agent never starts the model download, only the user's answer in the panel does.
import * as NodeOS from "node:os";

import {
  EngineError,
  TranscribeConsent,
  TranscribeEngineModelsStatus,
  TranscribeModelsDownloadResult,
  TranscribeRunResult,
  Transcript,
  TranscriptError,
  type MediaFingerprint,
  type TranscribeModel,
  type TranscribeModelsStatus,
  type TranscribeRunInput,
  type TranscriptMediaInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as EngineService from "../engine/EngineService.ts";
import { mediaFingerprint } from "./mediaFingerprint.ts";

const LIGHT_MODEL_MEMORY_BYTES = 8 * 1024 ** 3;
const CONSENT_FILE = "s7video-consent.json";

const decodeTranscript = Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript));
const ConsentFile = Schema.Struct({ consent: TranscribeConsent });
const decodeConsent = Schema.decodeUnknownOption(Schema.fromJsonString(ConsentFile));

export interface TranscriptServiceOptions {
  /** Physical memory; tests fake an 8 GB Mac. */
  readonly totalMemoryBytes?: number;
}

export interface TranscriptTextInput extends TranscriptMediaInput {
  readonly fromFrame?: number;
  readonly toFrame?: number;
}

export class TranscriptService extends Context.Service<
  TranscriptService,
  {
    /** Transcribes as an engine job, or answers from the project's cache without loading a model. */
    readonly transcribe: (
      input: TranscribeRunInput,
    ) => Effect.Effect<TranscribeRunResult, EngineError | TranscriptError>;
    /** The cached transcript, or null if this media has not been transcribed. */
    readonly get: (
      input: TranscriptMediaInput,
    ) => Effect.Effect<Transcript | null, TranscriptError>;
    /** The cached words as short lines stamped with frames, for agent context; null if none. */
    readonly readText: (
      input: TranscriptTextInput,
    ) => Effect.Effect<string | null, TranscriptError>;
    readonly modelsStatus: Effect.Effect<TranscribeModelsStatus, EngineError>;
    /** The user's yes in the Editor panel: records it, then downloads as an engine job. */
    readonly downloadModels: (
      model: TranscribeModel,
    ) => Effect.Effect<TranscribeModelsDownloadResult, EngineError | TranscriptError>;
    /** The user's "not now": the panel does not ask again on its own. */
    readonly dismissDownload: Effect.Effect<TranscribeModelsStatus, EngineError | TranscriptError>;
  }
>()("t3/transcript/TranscriptService") {}

/** Words grouped into lines at pauses of half a second or more, at most 12 words a line. */
function packTranscriptText(
  transcript: Transcript,
  range: { readonly fromFrame?: number; readonly toFrame?: number } = {},
): string {
  const { num, den } = transcript.fps;
  const pauseFrames = Math.max(1, Math.round((num / den) * 0.5));
  const from = range.fromFrame ?? 0;
  const to = range.toFrame ?? Number.POSITIVE_INFINITY;
  const words = transcript.words.filter((word) => word.endFrame > from && word.startFrame < to);
  const lines: string[] = [`fps ${num}/${den}; [start-end] are frames of the clip.`];
  let line: typeof words = [];
  const flush = () => {
    const first = line[0];
    const last = line.at(-1);
    if (first && last) {
      lines.push(
        `[${first.startFrame}-${last.endFrame}] ${line.map((word) => word.text).join(" ")}`,
      );
    }
    line = [];
  };
  for (const word of words) {
    const previous = line.at(-1);
    if (previous && (word.startFrame - previous.endFrame >= pauseFrames || line.length >= 12)) {
      flush();
    }
    line.push(word);
  }
  flush();
  if (words.length === 0) lines.push("(no words in this range)");
  return lines.join("\n");
}

const make = Effect.fn("TranscriptService.make")(function* (options: TranscriptServiceOptions) {
  const config = yield* ServerConfig.ServerConfig;
  const engine = yield* EngineService.EngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const consentLock = yield* Semaphore.make(1);
  const totalMemory = options.totalMemoryBytes ?? NodeOS.totalmem();
  const recommended: TranscribeModel =
    totalMemory <= LIGHT_MODEL_MEMORY_BYTES ? "light" : "default";
  const consentPath = path.join(config.engineModelsDir, CONSENT_FILE);

  const media = Effect.fnUntraced(function* (input: TranscriptMediaInput) {
    const mediaPath = path.resolve(input.projectRoot, input.mediaPath);
    const fingerprint: MediaFingerprint =
      input.fingerprint ??
      (yield* mediaFingerprint(mediaPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError((cause) => new TranscriptError({ reason: "media_unreadable", cause })),
      ));
    const cacheDir = path.join(input.projectRoot, ".s7cache", "transcripts");
    return { mediaPath, fingerprint, cacheDir };
  });

  const readConsent = fileSystem.readFileString(consentPath).pipe(
    Effect.map((text) => {
      const decoded = decodeConsent(text);
      return decoded._tag === "Some" ? decoded.value.consent : "unasked";
    }),
    Effect.orElseSucceed((): TranscribeConsent => "unasked"),
  );

  const writeConsent = (consent: TranscribeConsent) =>
    consentLock.withPermit(
      fileSystem.makeDirectory(config.engineModelsDir, { recursive: true }).pipe(
        Effect.andThen(fileSystem.writeFileString(consentPath, JSON.stringify({ consent }))),
        Effect.mapError((cause) => new TranscriptError({ reason: "consent_unsaved", cause })),
      ),
    );

  const engineStatus = engine.call("transcribe.models.status", {}, TranscribeEngineModelsStatus);

  const modelsStatus = Effect.gen(function* () {
    const status = yield* engineStatus;
    const profile = (name: TranscribeModel) => {
      const keys = status.profiles[name].models;
      return {
        sizeBytes: status.profiles[name].sizeBytes,
        downloadedBytes: keys.reduce(
          (sum, key) => sum + (status.models[key]?.downloadedBytes ?? 0),
          0,
        ),
        ready: status.profiles[name].ready,
      };
    };
    return {
      profiles: { default: profile("default"), light: profile("light") },
      recommended,
      consent: yield* readConsent,
      loadedProfile: status.loadedProfile,
    } satisfies TranscribeModelsStatus;
  }).pipe(Effect.withSpan("TranscriptService.modelsStatus"));

  const get = Effect.fn("TranscriptService.get")(function* (input: TranscriptMediaInput) {
    const { fingerprint, cacheDir } = yield* media(input);
    const file = path.join(cacheDir, `${fingerprint.sha256}.json`);
    const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
    if (text._tag === "None") return null;
    const transcript = yield* decodeTranscript(text.value).pipe(
      Effect.mapError((cause) => new TranscriptError({ reason: "cache_unreadable", cause })),
    );
    const same =
      transcript.mediaFingerprint.sha256 === fingerprint.sha256 &&
      transcript.mediaFingerprint.size === fingerprint.size;
    return same ? transcript : null;
  });

  const readText = Effect.fn("TranscriptService.readText")(function* (input: TranscriptTextInput) {
    const transcript = yield* get(input);
    if (transcript === null) return null;
    return packTranscriptText(transcript, {
      ...(input.fromFrame === undefined ? {} : { fromFrame: input.fromFrame }),
      ...(input.toFrame === undefined ? {} : { toFrame: input.toFrame }),
    });
  });

  const transcribe = Effect.fn("TranscriptService.transcribe")(function* (
    input: TranscribeRunInput,
  ) {
    const { mediaPath, fingerprint, cacheDir } = yield* media(input);
    // Unasked: the downloaded model wins, then the one this Mac should use.
    let model = input.model;
    if (model === undefined) {
      const status = yield* engineStatus;
      model = status.profiles.default.ready
        ? "default"
        : status.profiles.light.ready
          ? "light"
          : recommended;
    }
    yield* Effect.annotateCurrentSpan({ "transcribe.model": model });
    return yield* engine.runJob({
      kind: "transcribe",
      method: "transcribe.run",
      params: { path: mediaPath, cacheDir, fingerprint, model },
      success: TranscribeRunResult,
    });
  });

  const downloadModels = Effect.fn("TranscriptService.downloadModels")(function* (
    model: TranscribeModel,
  ) {
    yield* writeConsent("accepted");
    return yield* engine.runJob({
      kind: "transcribe.models.download",
      method: "transcribe.models.download",
      params: { model },
      success: TranscribeModelsDownloadResult,
    });
  });

  const dismissDownload = writeConsent("dismissed").pipe(
    Effect.andThen(modelsStatus),
    Effect.withSpan("TranscriptService.dismissDownload"),
  );

  return TranscriptService.of({
    transcribe,
    get,
    readText,
    modelsStatus,
    downloadModels,
    dismissDownload,
  });
});

export const layerWith = (options: TranscriptServiceOptions) =>
  Layer.effect(TranscriptService, make(options));

export const layer = layerWith({});
