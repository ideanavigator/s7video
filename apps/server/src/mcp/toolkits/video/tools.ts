// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The `video` toolkit (ADR-004). Claude finds these through ToolSearch, so names start with `video_`
// and descriptions say what they read: video, clip, frame, edit, job. Keep them short; every byte
// is sent with each turn (AgentContextBudget.test.ts).
import {
  EditAspectRatio,
  EditRational,
  EngineJob,
  EngineJobId,
  EngineJobState,
  MediaProbeResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as CaptionTrackService from "../../../edit/CaptionTrackService.ts";
import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import * as SilenceCutService from "../../../edit/SilenceCutService.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ExportService from "../../../export/ExportService.ts";
import * as MediaLibraryService from "../../../media/MediaLibraryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TranscriptService from "../../../transcript/TranscriptService.ts";
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

const transcriptDependencies = [...dependencies, TranscriptService.TranscriptService];

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
  description:
    "List video jobs, running or recently ended. waitSeconds (max 30) waits for jobId to end.",
  parameters: Schema.Struct({
    jobId: Schema.optional(EngineJobId),
    waitSeconds: Schema.optional(Schema.Int),
  }),
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

// Answers with the job at once; the agent follows it with video_job_status (S7V-028). User-triggered
// only (S7V-061). No preset: the export renders the edit's canvas, which video_canvas changes, so the
// video always has the shape the player shows.
const VideoExportTool = Tool.make("video_export", {
  description: "Export video to MP4 only if user asks. Returns a job.",
  parameters: Schema.Struct({ captions: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ jobId: EngineJobId, path: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, ExportService.ExportService],
})
  .annotate(Tool.Title, "Export video")
  .annotateMerge(videoAnnotations(false));

// Starts a job (S7V-026); the agent follows it with video_job_status. A cached clip answers at once.
const VideoTranscribeTool = Tool.make("video_transcribe", {
  description: "Transcribe a video clip's speech. Returns jobId, or cached.",
  parameters: Schema.Struct({ media: Schema.String }),
  success: Schema.Struct({
    jobId: Schema.optional(EngineJobId),
    cached: Schema.optional(Schema.Boolean),
    wordCount: Schema.optional(Schema.Int),
    durationFrames: Schema.optional(Schema.Int),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: transcriptDependencies,
})
  .annotate(Tool.Title, "Transcribe clip")
  .annotateMerge(videoAnnotations(false));

const VideoTranscriptReadTool = Tool.make("video_transcript_read", {
  // No frame range: it would cost about 55 more bytes on every turn (AgentContextBudget).
  description: "Read a video clip's transcript, frame-stamped lines.",
  parameters: Schema.Struct({ media: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: transcriptDependencies,
})
  .annotate(Tool.Title, "Read transcript")
  .annotateMerge(READS);

const VideoImportTool = Tool.make("video_import", {
  description: "Import a file the user shared into the video project.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({
    media: Schema.String,
    jobId: Schema.optional(EngineJobId),
    cleanup: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    ...dependencies,
    MediaLibraryService.MediaLibraryService,
    ServerConfig.ServerConfig,
  ],
})
  .annotate(Tool.Title, "Import clip")
  .annotateMerge(videoAnnotations(false));

/** `cleanup`: S7V-050's one-line hint, present when the history is due a cleanup question. */
const Cleanup = Schema.optional(Schema.String);
const EditStep = Schema.Struct({ revision: Schema.Int, message: Schema.String, cleanup: Cleanup });

const VideoUndoTool = Tool.make("video_undo", {
  description: "Undo the last edit to this video project. Use this, not git.",
  success: EditStep,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Undo edit")
  .annotateMerge(videoAnnotations(false));

const VideoRedoTool = Tool.make("video_redo", {
  description: "Redo the last undone edit to this video project. Use this, not git.",
  success: EditStep,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Redo edit")
  .annotateMerge(videoAnnotations(false));

// S7V-061: user-triggered only. One checkpoint, so undo puts the old shape back.
const VideoCanvasTool = Tool.make("video_canvas", {
  description: "Set video aspect ratio only if user asks.",
  parameters: Schema.Struct({ ratio: EditAspectRatio }),
  success: EditStep,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Set video shape")
  .annotateMerge(videoAnnotations(false));

// S7V-027: user-triggered only (PO rule). `keep` is text ("9-30,60-90", end exclusive) in clip
// frames, as video_transcript_read shows them: a list of objects would not fit the 250 B budget.
const VideoRemoveSilencesTool = Tool.make("video_remove_silences", {
  description: "Cut video silences only if user asks. keep: clip frames 9-30,60-90",
  parameters: Schema.Struct({
    media: Schema.optional(Schema.String),
    minGapSeconds: Schema.optional(Schema.Finite),
    keep: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    media: Schema.String,
    removedSeconds: Schema.Number,
    cuts: Schema.Int,
    keptSegments: Schema.Int,
    shortestSegmentFrames: Schema.Int,
    keptRequests: Schema.Int,
    message: Schema.String,
    revision: Schema.Int,
    changed: Schema.Boolean,
    cleanup: Cleanup,
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, SilenceCutService.SilenceCutService],
})
  .annotate(Tool.Title, "Remove silences")
  .annotateMerge(videoAnnotations(false));

// S7V-039: user-triggered only. Inserts the clips in order (one checkpoint), at `at` or after the
// video track's last item, pushing later items right. Frames are edit frames.
const VideoAssembleTool = Tool.make("video_assemble", {
  description: "Add video clip parts in order, only if user asks.",
  parameters: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ mediaId: Schema.String, in: Schema.Int, duration: Schema.Int }),
    ),
    at: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({
    revision: Schema.Int,
    itemIds: Schema.Array(Schema.String),
    cleanup: Cleanup,
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Assemble clips")
  .annotateMerge(videoAnnotations(false));

// S7V-075: user-triggered only. Writes the caption track from the clips' transcripts (one
// checkpoint); later cuts rebuild it. A clip with no transcript is refused: transcribe it first.
const VideoAddCaptionsTool = Tool.make("video_add_captions", {
  description: "Add captions to the video edit only if user asks.",
  success: EditStep,
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, CaptionTrackService.CaptionTrackService],
})
  .annotate(Tool.Title, "Add captions")
  .annotateMerge(videoAnnotations(false));

/** Tools that return JSON. A new tool goes here, with its handler in `handlers.ts`. */
export const VideoStandardToolkit = Toolkit.make(
  VideoImportTool,
  VideoProbeTool,
  VideoEditReadTool,
  VideoJobStatusTool,
  VideoJobCancelTool,
  VideoExportTool,
  VideoTranscribeTool,
  VideoTranscriptReadTool,
  VideoUndoTool,
  VideoRedoTool,
  VideoRemoveSilencesTool,
  VideoCanvasTool,
  VideoAssembleTool,
  VideoAddCaptionsTool,
);

/** `video_frame` returns image content, so it registers on its own (`registerVideoFrame`). */
export const VideoFrameToolkit = Toolkit.make(VideoFrameTool);

/** Every video tool. A video project's thread is offered these and nothing else (S7V-072). */
export const VideoToolkit = Toolkit.make(
  VideoImportTool,
  VideoProbeTool,
  VideoEditReadTool,
  VideoJobStatusTool,
  VideoJobCancelTool,
  VideoExportTool,
  VideoTranscribeTool,
  VideoTranscriptReadTool,
  VideoUndoTool,
  VideoRedoTool,
  VideoRemoveSilencesTool,
  VideoCanvasTool,
  VideoAssembleTool,
  VideoAddCaptionsTool,
  VideoFrameTool,
);

/**
 * s7video (S7V-072): the only tools a video project's thread is offered. Derived from the toolkits,
 * so a tool added to them shows up there with no other change.
 */
export const VIDEO_PROJECT_TOOL_NAMES: ReadonlySet<string> = new Set(
  [VideoToolkit, VideoStandardToolkit, VideoFrameToolkit].flatMap((toolkit) =>
    Object.keys(toolkit.tools),
  ),
);
