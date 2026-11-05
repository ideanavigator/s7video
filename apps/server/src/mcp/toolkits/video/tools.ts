// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The `video` toolkit (ADR-004). Claude finds these through ToolSearch, so names start with `video_`
// and descriptions say what they read: video, clip, frame, edit, job. Keep them short; every byte
// is sent with each turn (AgentContextBudget.test.ts).
import {
  EditRational,
  EngineJob,
  EngineJobId,
  EngineJobState,
  ExportPreset,
  MediaProbeResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ExportService from "../../../export/ExportService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  EditDocumentService.EditDocumentService,
  EngineService.EngineService,
  FileSystem.FileSystem,
  Path.Path,
];

const Media = Schema.String.annotate({
  description: "Media id or project file path.",
});

/** Every video tool is local and offered only to threads that have the `video` capability. */
const videoAnnotations = (readonly: boolean) =>
  Context.make(Tool.Readonly, readonly).pipe(
    Context.add(Tool.Destructive, false),
    Context.add(Tool.Idempotent, readonly),
    Context.add(Tool.OpenWorld, false),
    Context.add(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutVideo),
  );
const READS = videoAnnotations(true);

const VideoProbeTool = Tool.make("video_probe", {
  description: "Read a video clip's length (frames), fps, size, codecs.",
  parameters: Schema.Struct({ media: Media }),
  success: Schema.Struct({ ...MediaProbeResult.fields, media: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Probe clip")
  .annotateMerge(READS);

export const VideoFrameTool = Tool.make("video_frame", {
  description: "View one video frame as a PNG (frame: 0-based, clip fps).",
  parameters: Schema.Struct({
    media: Schema.String,
    frame: Schema.Int,
    maxWidth: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({
    media: Schema.String,
    frame: Schema.Int,
    rate: EditRational,
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
  .annotate(Tool.Title, "View frame")
  .annotateMerge(READS);

const VideoEditReadTool = Tool.make("video_edit_read", {
  description: "Read the video edit: revision, fps, length, tracks, media ids.",
  success: Schema.Struct({
    revision: Schema.Int,
    fps: EditRational,
    canvas: Schema.Struct({ width: Schema.Int, height: Schema.Int }),
    durationFrames: Schema.Int,
    tracks: Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.String, items: Schema.Int }),
    ),
    media: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.String,
        durationFrames: Schema.optional(Schema.Int),
        label: Schema.optional(Schema.String),
      }),
    ),
    markers: Schema.Int,
    canUndo: Schema.Boolean,
    canRedo: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read edit")
  .annotateMerge(READS);

const VideoJobStatusTool = Tool.make("video_job_status", {
  description: "List video jobs.",
  parameters: Schema.Struct({ jobId: Schema.optional(EngineJobId) }),
  success: Schema.Struct({ jobs: Schema.Array(EngineJob) }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Video job status")
  .annotateMerge(READS);

const VideoJobCancelTool = Tool.make("video_job_cancel", {
  description: "Stop a video job.",
  parameters: Schema.Struct({ jobId: EngineJobId }),
  success: Schema.Struct({
    jobId: EngineJobId,
    state: Schema.Union([EngineJobState, Schema.Literal("stopping")]),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Cancel video job")
  .annotateMerge(videoAnnotations(false));

// Answers with the job at once; the agent follows it with video_job_status (S7V-028).
const VideoExportTool = Tool.make("video_export", {
  description: "Export the edit to MP4 with captions; returns a video job.",
  parameters: Schema.Struct({
    preset: Schema.optional(ExportPreset),
    captions: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ jobId: EngineJobId, path: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, ExportService.ExportService],
})
  .annotate(Tool.Title, "Export video")
  .annotateMerge(videoAnnotations(false));

/** Tools that return JSON. A new tool goes here, with its handler in `handlers.ts`. */
export const VideoStandardToolkit = Toolkit.make(
  VideoProbeTool,
  VideoEditReadTool,
  VideoJobStatusTool,
  VideoJobCancelTool,
  VideoExportTool,
);

/** `video_frame` returns image content, so it registers on its own (`registerVideoFrame`). */
export const VideoFrameToolkit = Toolkit.make(VideoFrameTool);

export const VideoToolkit = Toolkit.make(
  VideoProbeTool,
  VideoEditReadTool,
  VideoJobStatusTool,
  VideoJobCancelTool,
  VideoExportTool,
  VideoFrameTool,
);
