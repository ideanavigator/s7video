// S7V-020 A3 spike: video tools backed by the Python engine. Throwaway.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as EngineService from "../../../videoEngine/EngineService.ts";

const Path = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "Absolute path to a video file.",
});

const dependencies = [McpInvocationContext.McpInvocationContext, EngineService.EngineService];

const VideoProbeTool = Tool.make("video_probe", {
  description: "Read a video file's duration, size, container and streams.",
  parameters: Schema.Struct({ path: Path }),
  success: Schema.Struct({
    path: Schema.String,
    durationSeconds: Schema.Number,
    sizeBytes: Schema.Number,
    container: Schema.String,
    bitRate: Schema.Number,
    streams: Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        type: Schema.String,
        codec: Schema.String,
        width: Schema.optional(Schema.Number),
        height: Schema.optional(Schema.Number),
        fps: Schema.optional(Schema.String),
        pixFmt: Schema.optional(Schema.String),
        sampleRate: Schema.optional(Schema.String),
        channels: Schema.optional(Schema.Number),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Probe video")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VideoFrameTool = Tool.make("video_frame", {
  description: "Return one frame of a video as a PNG image, to look at a moment.",
  parameters: Schema.Struct({
    path: Path,
    t: Schema.Number.annotate({ description: "Time in seconds." }),
    width: Schema.optional(Schema.Int.annotate({ description: "Pixels, default 640." })),
  }),
  success: Schema.Struct({
    path: Schema.String,
    t: Schema.Number,
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Video frame")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VideoProbeToolkit = Toolkit.make(VideoProbeTool);
export const VideoFrameToolkit = Toolkit.make(VideoFrameTool);
