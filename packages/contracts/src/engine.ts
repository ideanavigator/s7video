// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The local video engine (packages/engine): its JSON-RPC wire messages, method schemas, errors and
// jobs (ADR-004). Media time crosses this boundary only as integer frames, integer ticks and
// `{num, den}` rationals, never as float seconds.
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EngineRational = Schema.Struct({ num: PositiveInt, den: PositiveInt });
export type EngineRational = typeof EngineRational.Type;

const NullableString = Schema.NullOr(Schema.String);

export const EnginePingResult = Schema.Struct({
  pong: Schema.Literal(true),
  protocol: PositiveInt,
  /** The Python process, a child of the spawned `uv`; the server reaps both through the group. */
  pid: PositiveInt,
});
export type EnginePingResult = typeof EnginePingResult.Type;

export const MediaProbeInput = Schema.Struct({ path: TrimmedNonEmptyString });
export type MediaProbeInput = typeof MediaProbeInput.Type;

export const MediaProbeVideo = Schema.Struct({
  index: NonNegativeInt,
  codec: Schema.String,
  profile: NullableString,
  width: NonNegativeInt,
  height: NonNegativeInt,
  pixelFormat: NullableString,
  /** The stream's base rate; `durationFrames` counts at this rate. */
  frameRate: EngineRational,
  averageFrameRate: EngineRational,
  variableFrameRate: Schema.Boolean,
  timeBase: EngineRational,
  /** Real presentation timestamps of the first and last frame, in `timeBase` ticks. */
  firstPts: Schema.Int,
  lastPts: Schema.Int,
  frameCount: NonNegativeInt,
  durationFrames: NonNegativeInt,
  rotation: NonNegativeInt,
  color: Schema.Struct({
    space: NullableString,
    transfer: NullableString,
    primaries: NullableString,
    range: NullableString,
  }),
});
export type MediaProbeVideo = typeof MediaProbeVideo.Type;

export const MediaProbeAudio = Schema.Struct({
  index: NonNegativeInt,
  codec: Schema.String,
  sampleRate: NonNegativeInt,
  channels: NonNegativeInt,
  channelLayout: NullableString,
  timeBase: EngineRational,
  firstPts: Schema.Int,
  durationSamples: Schema.NullOr(NonNegativeInt),
});
export type MediaProbeAudio = typeof MediaProbeAudio.Type;

export const MediaProbeResult = Schema.Struct({
  path: Schema.String,
  container: Schema.String,
  sizeBytes: NonNegativeInt,
  bitRate: Schema.NullOr(NonNegativeInt),
  /** The video's length in frames at its `frameRate`; null for audio-only files. */
  durationFrames: Schema.NullOr(NonNegativeInt),
  video: Schema.NullOr(MediaProbeVideo),
  audio: Schema.NullOr(MediaProbeAudio),
});
export type MediaProbeResult = typeof MediaProbeResult.Type;

export const MediaFrameInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Counted from the video's first frame at `rate`. */
  frame: NonNegativeInt,
  rate: EngineRational,
  maxWidth: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 8192 }))),
  /** Where the PNG is written; the server's engine scratch folder when absent. */
  outputDir: Schema.optional(TrimmedNonEmptyString),
});
export type MediaFrameInput = typeof MediaFrameInput.Type;

export const MediaFrameResult = Schema.Struct({
  /** A PNG file; frames never travel inline. */
  path: Schema.String,
  frame: NonNegativeInt,
  rate: EngineRational,
  width: PositiveInt,
  height: PositiveInt,
});
export type MediaFrameResult = typeof MediaFrameResult.Type;

export const MediaThumbnailInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Where the JPEG is written, replacing any file there. */
  outputPath: TrimmedNonEmptyString,
  /** Counted from the video's first frame at `rate`. */
  frame: NonNegativeInt,
  rate: EngineRational,
  maxWidth: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 1920 }))),
});
export type MediaThumbnailInput = typeof MediaThumbnailInput.Type;

export const MediaThumbnailResult = Schema.Struct({ path: Schema.String });
export type MediaThumbnailResult = typeof MediaThumbnailResult.Type;

export const MediaKeyframesInput = Schema.Struct({ path: TrimmedNonEmptyString });
export type MediaKeyframesInput = typeof MediaKeyframesInput.Type;

/** The longest keyframe gap over the first 10 s and 5 s mid-file, read from packet flags. */
export const MediaKeyframesResult = Schema.Struct({
  timeBase: EngineRational,
  maxGapTicks: NonNegativeInt,
  keyframes: NonNegativeInt,
  scannedTicks: NonNegativeInt,
});
export type MediaKeyframesResult = typeof MediaKeyframesResult.Type;

/** A preview copy that keeps every source timestamp; runs as a job. */
export const MediaProxyInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  outputPath: TrimmedNonEmptyString,
  rate: EngineRational,
  timeBase: EngineRational,
  durationFrames: PositiveInt,
  color: Schema.optional(
    Schema.Struct({
      primaries: Schema.optional(NullableString),
      transfer: Schema.optional(NullableString),
      space: Schema.optional(NullableString),
      range: Schema.optional(NullableString),
    }),
  ),
});
export type MediaProxyInput = typeof MediaProxyInput.Type;

export const MediaProxyResult = Schema.Struct({ path: Schema.String });
export type MediaProxyResult = typeof MediaProxyResult.Type;

/** `media.peaks` (S7V-035): a waveform mip written into `outputDir`, which the server chooses. */
export const MediaPeaksInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  outputDir: TrimmedNonEmptyString,
  /** Samples per peak, ascending, each dividing the next. Default 256, 1,024, 4,096, 16,384. */
  levels: Schema.optional(Schema.Array(PositiveInt)),
});
export type MediaPeaksInput = typeof MediaPeaksInput.Type;

export const MediaPeaksLevel = Schema.Struct({
  samplesPerPeak: PositiveInt,
  count: NonNegativeInt,
  /** A file in `outputDir`: `count` little-endian float32 `[min, max]` pairs. */
  file: TrimmedNonEmptyString,
});
export type MediaPeaksLevel = typeof MediaPeaksLevel.Type;

/** `audio: false` is the "no audio" marker: no levels, nothing to draw. */
export const MediaPeaksResult = Schema.Struct({
  audio: Schema.Boolean,
  sampleRate: PositiveInt,
  durationSamples: Schema.optional(NonNegativeInt),
  offsetSamples: Schema.optional(Schema.Int),
  levels: Schema.Array(MediaPeaksLevel),
});
export type MediaPeaksResult = typeof MediaPeaksResult.Type;

/** `media.filmstrip` (S7V-035): JPEG sprite sheets per level, written into `outputDir`. */
export const MediaFilmstripInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  outputDir: TrimmedNonEmptyString,
  /** The rate tile frames are counted at: the media's own frame rate. */
  rate: EngineRational,
  /** Seconds per tile. Default 16, 4 and 1. */
  levels: Schema.optional(Schema.Array(PositiveInt)),
  tileHeight: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 360 }))),
});
export type MediaFilmstripInput = typeof MediaFilmstripInput.Type;

export const MediaFilmstripLevelSummary = Schema.Struct({
  level: TrimmedNonEmptyString,
  secondsPerTile: PositiveInt,
  framesPerTile: PositiveInt,
  sheets: Schema.Array(TrimmedNonEmptyString),
  count: NonNegativeInt,
});

export const MediaFilmstripResult = Schema.Struct({
  rate: EngineRational,
  tileWidth: PositiveInt,
  tileHeight: PositiveInt,
  columns: PositiveInt,
  rows: PositiveInt,
  /** The index file in `outputDir` that maps every tile to its frame. */
  index: TrimmedNonEmptyString,
  levels: Schema.Array(MediaFilmstripLevelSummary),
});
export type MediaFilmstripResult = typeof MediaFilmstripResult.Type;

export const EngineJobCancelResult = Schema.Struct({ cancelled: Schema.Boolean });

/** `export.render`'s reply: the finished MP4 (S7V-028). Loudness is null for a silent export. */
export const ExportRenderResult = Schema.Struct({
  path: Schema.String,
  durationFrames: NonNegativeInt,
  fps: EngineRational,
  width: PositiveInt,
  height: PositiveInt,
  /** Caption chunks burned in. */
  captions: NonNegativeInt,
  measuredLufs: Schema.NullOr(Schema.Finite),
  gainDb: Schema.Finite,
  lufs: Schema.NullOr(Schema.Finite),
  truePeak: Schema.NullOr(Schema.Finite),
});
export type ExportRenderResult = typeof ExportRenderResult.Type;

/** Every engine method's response schema, for checks that apply to all of them. */
export const ENGINE_RESPONSE_SCHEMAS = {
  "engine.ping": EnginePingResult,
  "media.probe": MediaProbeResult,
  "media.frame": MediaFrameResult,
  "media.thumbnail": MediaThumbnailResult,
  "media.keyframes": MediaKeyframesResult,
  "media.proxy": MediaProxyResult,
  "media.peaks": MediaPeaksResult,
  "media.filmstrip": MediaFilmstripResult,
  "job.cancel": EngineJobCancelResult,
  "export.render": ExportRenderResult,
} as const;

export const ENGINE_RPC_ERROR_CODES = {
  fileNotFound: 1001,
  mediaError: 1002,
  cancelled: 1003,
  missingTool: 1004,
  outputError: 1005,
  modelsMissing: 1006,
  modelDownloadFailed: 1007,
  modelChecksumMismatch: 1008,
  diskFull: 1009,
  noAudio: 1010,
} as const;

export const EngineRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: NonNegativeInt,
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
});
export type EngineRpcRequest = typeof EngineRpcRequest.Type;

export const EngineRpcErrorBody = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(
    Schema.Struct({
      tool: Schema.optional(Schema.String),
      feature: Schema.optional(Schema.String),
      profile: Schema.optional(Schema.String),
    }),
  ),
});
export type EngineRpcErrorBody = typeof EngineRpcErrorBody.Type;

export const EngineProgressParams = Schema.Struct({
  jobId: Schema.String,
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  stage: NullableString,
});
export type EngineProgressParams = typeof EngineProgressParams.Type;

/** One line from the engine's stdout: a reply (result or error) or a notification. */
export const EngineRpcMessage = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.NullOr(Schema.Union([Schema.Int, Schema.String])),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.NullOr(Schema.Union([Schema.Int, Schema.String])),
    error: EngineRpcErrorBody,
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literal("ready"),
    params: Schema.Struct({ version: Schema.String, protocol: PositiveInt }),
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literal("progress"),
    params: EngineProgressParams,
  }),
]);
export type EngineRpcMessage = typeof EngineRpcMessage.Type;

export const EngineErrorReason = Schema.Literals([
  "start_failed",
  "crashed",
  "timeout",
  "rpc_error",
  "cancelled",
  "missing_tool",
  "models_missing",
]);
export type EngineErrorReason = typeof EngineErrorReason.Type;

export const EngineTool = Schema.Literals(["uv", "ffmpeg", "ffprobe"]);
export type EngineTool = typeof EngineTool.Type;

const INSTALL_HINT: Record<EngineTool, string> = {
  uv: "install it with `brew install uv`, or set S7VIDEO_UV to its full path",
  ffmpeg: "install it with `brew install ffmpeg`, or set S7VIDEO_FFMPEG to its full path",
  ffprobe:
    "install FFmpeg with `brew install ffmpeg` (it includes ffprobe), or set S7VIDEO_FFPROBE to its full path",
};

/** What a tool can lack even when it is installed: FFmpeg built without libass, VideoToolbox or zimg. */
export const EngineToolFeature = Schema.Literals(["libass", "h264_videotoolbox", "zscale"]);
export type EngineToolFeature = typeof EngineToolFeature.Type;

const FEATURE_PURPOSE: Record<EngineToolFeature, string> = {
  libass: "libass to burn in captions",
  h264_videotoolbox: "the h264_videotoolbox encoder to use the Mac's video hardware",
  zscale: "zscale (zimg) to convert HDR video to standard range",
};

/**
 * What an agent reads when a video tool needs the speech model (S7V-067). It names the button the
 * Editor panel shows, and the web recognises a tool result by it to open that panel.
 */
export const MODELS_MISSING_MESSAGE =
  "The speech model isn't downloaded yet. Ask the user to press Download speech model at the top of the Editor panel; s7video downloads it only after they agree.";

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
  reason: EngineErrorReason,
  /** The engine method, or `start` while the engine was starting. */
  method: Schema.String,
  tool: Schema.optional(EngineTool),
  /** For `missing_tool`: the tool is there but was built without this. */
  feature: Schema.optional(EngineToolFeature),
  /** The engine's own fixed rejection text, for `rpc_error`. */
  rpcMessage: Schema.optional(Schema.String),
  rpcCode: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "start_failed":
        return "The video engine could not start. Try again; if it keeps failing, restart s7video.";
      case "crashed":
        return `The video engine stopped during ${this.method}. It restarts on the next call; try again.`;
      case "timeout":
        return `The video engine did not answer ${this.method} in time. Try again; a stuck engine restarts on its own.`;
      case "rpc_error":
        return `The video engine rejected ${this.method}: ${this.rpcMessage ?? "unknown error"}.`;
      case "cancelled":
        return `The video engine stopped ${this.method} because it was cancelled.`;
      case "models_missing":
        return MODELS_MISSING_MESSAGE;
      case "missing_tool": {
        const tool = this.tool ?? "ffmpeg";
        if (this.feature !== undefined) {
          return `The video engine needs an ${tool} with ${FEATURE_PURPOSE[this.feature]}, and the ${tool} on this Mac was built without it. For development, ${INSTALL_HINT[tool]}.`;
        }
        return `The video engine needs ${tool}, which was not found on this Mac. For development, ${INSTALL_HINT[tool]}.`;
      }
    }
  }
}

export const EngineJobId = TrimmedNonEmptyString.pipe(Schema.brand("EngineJobId"));
export type EngineJobId = typeof EngineJobId.Type;

export const EngineJobState = Schema.Literals(["running", "succeeded", "failed", "cancelled"]);
export type EngineJobState = typeof EngineJobState.Type;

export const EngineJob = Schema.Struct({
  id: EngineJobId,
  /** What the job does, for example `transcribe` or `export`. */
  kind: Schema.String,
  /** 0..1, as the engine last reported it. */
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  stage: NullableString,
  state: EngineJobState,
  /** The project the job works for; agents see only their own project's jobs. */
  projectId: Schema.optional(ProjectId),
  /** Why a `failed` job failed, in plain words. */
  message: Schema.optional(Schema.String),
});
export type EngineJob = typeof EngineJob.Type;

export const EngineJobsSubscribeInput = Schema.Struct({});
export type EngineJobsSubscribeInput = typeof EngineJobsSubscribeInput.Type;

export const EngineJobsEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), jobs: Schema.Array(EngineJob) }),
  Schema.Struct({ type: Schema.Literal("updated"), job: EngineJob }),
]);
export type EngineJobsEvent = typeof EngineJobsEvent.Type;

export const EngineJobsCancelInput = Schema.Struct({ jobId: EngineJobId });
export type EngineJobsCancelInput = typeof EngineJobsCancelInput.Type;

export const EngineJobsCancelResult = Schema.Struct({ applied: Schema.Boolean });
export type EngineJobsCancelResult = typeof EngineJobsCancelResult.Type;

/** Export (S7V-028) output canvas: the edit's own when absent. */
export const ExportPreset = Schema.Literals(["reel-9x16", "square", "landscape"]);
export type ExportPreset = typeof ExportPreset.Type;

export const ExportStartInput = Schema.Struct({
  projectId: ProjectId,
  preset: Schema.optional(ExportPreset),
  /** Burn in the edit's captions; on unless turned off (PO default, S7V-028). */
  captions: Schema.optional(Schema.Boolean),
});
export type ExportStartInput = typeof ExportStartInput.Type;

export const ExportStartResult = Schema.Struct({
  jobId: EngineJobId,
  /** Where the video will land, relative to the project folder (`exports/…mp4`). */
  path: TrimmedNonEmptyString,
});
export type ExportStartResult = typeof ExportStartResult.Type;

/** A finished export, as clients and agents see it: paths are project-relative. */
export const ExportResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  durationFrames: NonNegativeInt,
  fps: EngineRational,
  width: PositiveInt,
  height: PositiveInt,
  captions: NonNegativeInt,
  lufs: Schema.NullOr(Schema.Finite),
  truePeak: Schema.NullOr(Schema.Finite),
});
export type ExportResult = typeof ExportResult.Type;

export const ExportStatusInput = Schema.Struct({ jobId: EngineJobId });
export type ExportStatusInput = typeof ExportStatusInput.Type;

export const ExportStatus = Schema.Struct({
  jobId: EngineJobId,
  projectId: ProjectId,
  path: TrimmedNonEmptyString,
  state: EngineJobState,
  result: Schema.optional(ExportResult),
  /** The plain reason a failed export stopped. */
  message: Schema.optional(Schema.String),
});
export type ExportStatus = typeof ExportStatus.Type;

export class ExportStartError extends Schema.TaggedError<ExportStartError>()("ExportStartError", {
  projectId: ProjectId,
  /** `no-transcript`: captions are on, the edit has none, and a clip has no transcript (S7V-046). */
  reason: Schema.Literals(["exports-folder", "no-transcript"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "no-transcript"
      ? "Transcribe the clip first, or export without captions."
      : "Could not create the project's exports folder.";
  }
}

/**
 * `captions.render`: the export's caption chunks, each naming a transparent PNG still in
 * `cacheDir/<folder>/` (S7V-075). `drawn` counts the stills drawn by this call; the rest were cached.
 */
export const CaptionsRenderResult = Schema.Struct({
  width: PositiveInt,
  height: PositiveInt,
  folder: TrimmedNonEmptyString,
  drawn: NonNegativeInt,
  chunks: Schema.Array(
    Schema.Struct({ start: NonNegativeInt, end: NonNegativeInt, png: TrimmedNonEmptyString }),
  ),
});
export type CaptionsRenderResult = typeof CaptionsRenderResult.Type;

/**
 * `captions.stills`: the export's captions in timeline frames (`end` exclusive), each naming one
 * of `stills`, a whole-canvas PNG fetched from `stillsUrl` + its name (S7V-079). `folder/name`
 * hashes all its pixels depend on, so it is a cache key for good. `missing` names the clips with
 * sound whose transcript can't be read, so their captions can't follow the edit.
 */
export const CaptionStillsResult = Schema.Struct({
  key: Schema.String,
  width: PositiveInt,
  height: PositiveInt,
  chunks: Schema.Array(
    Schema.Struct({ start: NonNegativeInt, end: NonNegativeInt, still: NonNegativeInt }),
  ),
  folder: Schema.String,
  stillsUrl: Schema.String,
  stills: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
});
export type CaptionStillsResult = typeof CaptionStillsResult.Type;

/** "Add captions" refused (S7V-075): a clip on the video track has no transcript, or none has sound. */
export class CaptionsError extends Schema.TaggedError<CaptionsError>()("CaptionsError", {
  reason: Schema.Literals(["no-transcript", "no-clips"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** `media.loudness` (S7V-036): integrated loudness (EBU R128) of a file's first audio stream. */
export const MediaLoudnessInput = Schema.Struct({ path: TrimmedNonEmptyString });
export type MediaLoudnessInput = typeof MediaLoudnessInput.Type;

/** `null` for silence: nothing above the −70 LUFS gate. */
export const MediaLoudnessResult = Schema.Struct({ integratedLufs: Schema.NullOr(Schema.Finite) });
export type MediaLoudnessResult = typeof MediaLoudnessResult.Type;

/** A sound effect or music the agent can't place or duck, with the plain next step (S7V-036). */
export class SoundError extends Schema.TaggedError<SoundError>()("SoundError", {
  reason: Schema.Literals([
    "unknown-media",
    "no-sound",
    "no-video",
    "which-clip",
    "cut",
    "out-of-range",
    "no-music",
    "no-transcript",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** `silence.detect`: whole-decibel RMS dBFS of the sound under each video frame (S7V-027). */
export const SilenceDetectResult = Schema.Struct({
  rate: EngineRational,
  durationFrames: NonNegativeInt,
  levels: Schema.Array(Schema.Int),
});
export type SilenceDetectResult = typeof SilenceDetectResult.Type;

/**
 * Why silence removal did not run; the message tells the agent what to do next. `measuring`: the
 * clip's sound is still being measured by a `silence` job, to wait for and then call again (S7V-055).
 */
export class SilenceCutError extends Schema.TaggedError<SilenceCutError>()("SilenceCutError", {
  reason: Schema.Literals([
    "media",
    "no-transcript",
    "no-speech",
    "linked-audio",
    "keep",
    "measuring",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
