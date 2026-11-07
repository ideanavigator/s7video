// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Built-in transcription (S7V-026, ADR-006): the cached transcript, the engine's transcribe and
// model methods, and the WebSocket requests the Editor panel uses. Word times are integer frames
// at the transcript's `fps`, never seconds.
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EngineRational } from "./engine.ts";

/** `default` is Qwen3-ASR 1.7B; `light` is Qwen3-ASR 0.6B, offered on Macs with 8 GB or less. */
export const TranscribeModel = Schema.Literals(["default", "light"]);
export type TranscribeModel = typeof TranscribeModel.Type;

/** sha256 over the first and last MiB of the file (the whole file when 2 MiB or less), plus its size. */
export const MediaFingerprint = Schema.Struct({
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  size: NonNegativeInt,
});
export type MediaFingerprint = typeof MediaFingerprint.Type;

export const TranscriptWord = Schema.Struct({
  text: Schema.String,
  startFrame: NonNegativeInt,
  /** Exclusive: the first frame after the word. */
  endFrame: NonNegativeInt,
  /** Geometric mean probability of the recogniser's tokens for this word; null if unmatched. */
  confidence: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /** `S1` only until speaker detection exists. */
  speaker: Schema.String,
});
export type TranscriptWord = typeof TranscriptWord.Type;

/** `.s7cache/transcripts/<fingerprint sha256>.json` in the project. */
export const Transcript = Schema.Struct({
  transcriptVersion: Schema.Literal(1),
  mediaFingerprint: MediaFingerprint,
  model: Schema.String,
  revision: Schema.String,
  /** The video's frame rate; frame 0 is its first frame. 30 fps for audio-only files. */
  fps: EngineRational,
  durationFrames: NonNegativeInt,
  words: Schema.Array(TranscriptWord),
  createdAt: Schema.String,
});
export type Transcript = typeof Transcript.Type;

/**
 * `.s7cache/transcripts/<fingerprint sha256>.levels.json`: whole-decibel RMS dBFS of the sound
 * under each frame, as `silence.detect` measures it. The transcribe job writes it beside the
 * transcript; silence removal reads it instead of decoding the clip again (S7V-055).
 */
export const SilenceLevels = Schema.Struct({
  levelsVersion: Schema.Literal(1),
  mediaFingerprint: MediaFingerprint,
  fps: EngineRational,
  durationFrames: NonNegativeInt,
  levels: Schema.Array(Schema.Int),
});
export type SilenceLevels = typeof SilenceLevels.Type;

export const TranscribeRunResult = Schema.Struct({
  /** The cached transcript file. */
  path: Schema.String,
  /** True when the cache answered and no model was loaded. */
  cached: Schema.Boolean,
  model: Schema.String,
  fps: EngineRational,
  wordCount: NonNegativeInt,
  durationFrames: NonNegativeInt,
  timings: Schema.optional(
    Schema.Struct({
      loadMs: NonNegativeInt,
      totalMs: NonNegativeInt,
      /** MLX's peak GPU memory during the job (0 when unknown). */
      peakMemoryBytes: NonNegativeInt,
    }),
  ),
});
export type TranscribeRunResult = typeof TranscribeRunResult.Type;

const EngineModelState = Schema.Struct({
  repo: Schema.String,
  revision: Schema.String,
  sizeBytes: NonNegativeInt,
  downloadedBytes: NonNegativeInt,
  ready: Schema.Boolean,
});

/**
 * A copy of the pinned models already in another Hugging Face cache on this Mac (S7V-067), every
 * file at its locked size; using it checks each sha256. `copyBytes` is the free space it takes:
 * 0 when the files can be cloned (same volume), else the size of a plain copy.
 */
export const TranscribeFoundCopy = Schema.Struct({ copyBytes: NonNegativeInt });
export type TranscribeFoundCopy = typeof TranscribeFoundCopy.Type;

const EngineProfileState = Schema.Struct({
  models: Schema.Array(Schema.String),
  sizeBytes: NonNegativeInt,
  ready: Schema.Boolean,
  found: Schema.optional(Schema.NullOr(TranscribeFoundCopy)),
});

/** `transcribe.models.status` as the engine answers it. */
export const TranscribeEngineModelsStatus = Schema.Struct({
  models: Schema.Record(Schema.String, EngineModelState),
  profiles: Schema.Struct({ default: EngineProfileState, light: EngineProfileState }),
  loadedProfile: Schema.NullOr(TranscribeModel),
});
export type TranscribeEngineModelsStatus = typeof TranscribeEngineModelsStatus.Type;

export const TranscribeModelsDownloadResult = Schema.Struct({
  profile: TranscribeModel,
  ready: Schema.Boolean,
  sizeBytes: NonNegativeInt,
});
export type TranscribeModelsDownloadResult = typeof TranscribeModelsDownloadResult.Type;

/** Whether the user has answered the download question: it is asked once, not on every request. */
export const TranscribeConsent = Schema.Literals(["unasked", "accepted", "dismissed"]);
export type TranscribeConsent = typeof TranscribeConsent.Type;

export const TranscribeProfileStatus = Schema.Struct({
  sizeBytes: NonNegativeInt,
  downloadedBytes: NonNegativeInt,
  ready: Schema.Boolean,
  /** Set when a copy on this Mac can be used instead of downloading. */
  found: Schema.optional(TranscribeFoundCopy),
});
export type TranscribeProfileStatus = typeof TranscribeProfileStatus.Type;

export const TranscribeModelsStatus = Schema.Struct({
  profiles: Schema.Struct({ default: TranscribeProfileStatus, light: TranscribeProfileStatus }),
  /** `light` on Macs with 8 GB of memory or less. */
  recommended: TranscribeModel,
  consent: TranscribeConsent,
  /** Loaded in memory now; it unloads after the idle timeout. */
  loadedProfile: Schema.NullOr(TranscribeModel),
});
export type TranscribeModelsStatus = typeof TranscribeModelsStatus.Type;

/**
 * A project's media: an `edit.json` media id or a path inside the project. The server resolves the
 * project and checks the media belongs to it; the transcript cache is that project's
 * `.s7cache/transcripts`, keyed by a fingerprint the server computes from the file.
 */
export const TranscriptMediaInput = Schema.Struct({
  projectId: ProjectId,
  media: TrimmedNonEmptyString,
});
export type TranscriptMediaInput = typeof TranscriptMediaInput.Type;

export const TranscribeRunInput = Schema.Struct({
  ...TranscriptMediaInput.fields,
  model: Schema.optional(TranscribeModel),
});
export type TranscribeRunInput = typeof TranscribeRunInput.Type;

export const TranscriptGetResult = Schema.Struct({ transcript: Schema.NullOr(Transcript) });
export type TranscriptGetResult = typeof TranscriptGetResult.Type;

export const TranscribeModelsStatusInput = Schema.Struct({});
export type TranscribeModelsStatusInput = typeof TranscribeModelsStatusInput.Type;

export const TranscribeModelsDownloadInput = Schema.Struct({
  model: TranscribeModel,
  /** The project the user accepted the download in, so its agents can follow the job. */
  projectId: Schema.optional(ProjectId),
  /**
   * Use the copy found on this Mac instead of the network: `clone` only clones it, `copy` (the
   * user agreed to the space it takes) may copy it.
   */
  reuse: Schema.optional(Schema.Literals(["clone", "copy"])),
});
export type TranscribeModelsDownloadInput = typeof TranscribeModelsDownloadInput.Type;

export const TranscribeModelsDismissInput = Schema.Struct({});
export type TranscribeModelsDismissInput = typeof TranscribeModelsDismissInput.Type;

export class TranscriptError extends Schema.TaggedError<TranscriptError>()("TranscriptError", {
  reason: Schema.Literals([
    "media_refused",
    "media_unreadable",
    "cache_unreadable",
    "consent_unsaved",
  ]),
  /** For `media_refused`: the plain reason (not in this project, no such file, no project). */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "media_refused":
        return this.detail ?? "That file is not part of this project.";
      case "media_unreadable":
        return "The media file could not be read.";
      case "cache_unreadable":
        return "The saved transcript could not be read; transcribe the clip again.";
      case "consent_unsaved":
        return "Your answer to the model download could not be saved.";
    }
  }
}
