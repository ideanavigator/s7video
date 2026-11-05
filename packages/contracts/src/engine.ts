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

export const EngineJobCancelResult = Schema.Struct({ cancelled: Schema.Boolean });

/** Every engine method's response schema, for checks that apply to all of them. */
export const ENGINE_RESPONSE_SCHEMAS = {
  "engine.ping": EnginePingResult,
  "media.probe": MediaProbeResult,
  "media.frame": MediaFrameResult,
  "job.cancel": EngineJobCancelResult,
} as const;

export const ENGINE_RPC_ERROR_CODES = {
  fileNotFound: 1001,
  mediaError: 1002,
  cancelled: 1003,
  missingTool: 1004,
  outputError: 1005,
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
  data: Schema.optional(Schema.Struct({ tool: Schema.optional(Schema.String) })),
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

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
  reason: EngineErrorReason,
  /** The engine method, or `start` while the engine was starting. */
  method: Schema.String,
  tool: Schema.optional(EngineTool),
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
      case "missing_tool": {
        const tool = this.tool ?? "ffmpeg";
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
