// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A project's media library (S7V-025): importing footage by copy or by reference, the Assets list,
 * and relinking a moved original. Media entries live in `edit.json`; proxy and import progress are
 * runtime state and never written there. Lengths are integer frames, never float seconds.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EditId, EditMediaKind, EditRational } from "./edit.ts";
import { EngineJobId } from "./engine.ts";

const SourcePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

/** `copy` keeps the project's own copy in `assets/`; `reference` points at the file where it is. */
export const MediaImportMode = Schema.Literals(["copy", "reference"]);
export type MediaImportMode = typeof MediaImportMode.Type;

/** What `/api/assets` serves for one media; `peaks` and `filmstrip` are reserved for S7V-035. */
export const MediaVariant = Schema.Literals([
  "original",
  "proxy",
  "thumbnail",
  "peaks",
  "filmstrip",
]);
export type MediaVariant = typeof MediaVariant.Type;

export const MediaImportPlanInput = Schema.Struct({
  projectId: ProjectId,
  sourcePaths: Schema.Array(SourcePath).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type MediaImportPlanInput = typeof MediaImportPlanInput.Type;

/** The import dialog's default; `reason` says why copy is not the default. */
export const MediaImportPlan = Schema.Struct({
  suggestedMode: MediaImportMode,
  reason: Schema.optional(Schema.String),
  totalBytes: NonNegativeInt,
  freeBytes: NonNegativeInt,
});
export type MediaImportPlan = typeof MediaImportPlan.Type;

export const MediaImportInput = Schema.Struct({
  projectId: ProjectId,
  sourcePath: SourcePath,
  mode: MediaImportMode,
});
export type MediaImportInput = typeof MediaImportInput.Type;

export const MediaImportResult = Schema.Struct({
  mediaId: EditId,
  /** The background proxy job, when the clip needs one. */
  jobId: Schema.optional(EngineJobId),
});
export type MediaImportResult = typeof MediaImportResult.Type;

export const MediaRelinkInput = Schema.Struct({
  projectId: ProjectId,
  mediaId: EditId,
  sourcePath: SourcePath,
});
export type MediaRelinkInput = typeof MediaRelinkInput.Type;

export const MediaLibraryInput = Schema.Struct({ projectId: ProjectId });
export type MediaLibraryInput = typeof MediaLibraryInput.Type;

export const MediaProxyState = Schema.Struct({
  status: Schema.Literals(["none", "preparing", "ready", "failed"]),
  jobId: Schema.optional(EngineJobId),
  /** 0..1 while preparing. */
  progress: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
});
export type MediaProxyState = typeof MediaProxyState.Type;

export const MediaAsset = Schema.Struct({
  id: EditId,
  kind: EditMediaKind,
  label: Schema.String,
  storage: MediaImportMode,
  /** Project-relative for a copy, absolute for a reference. */
  location: Schema.String,
  /** `missing`: a referenced original was moved or deleted. */
  state: Schema.Literals(["ready", "missing"]),
  sizeBytes: NonNegativeInt,
  /** Length in frames at the media's own rate (`fps`); audio-only media count at the document fps. */
  durationFrames: Schema.optional(NonNegativeInt),
  fps: Schema.optional(EditRational),
  width: Schema.optional(PositiveInt),
  height: Schema.optional(PositiveInt),
  hasVideo: Schema.Boolean,
  hasAudio: Schema.Boolean,
  hasThumbnail: Schema.Boolean,
  proxy: MediaProxyState,
});
export type MediaAsset = typeof MediaAsset.Type;

/** A copy still being written into `assets/`. */
export const MediaImporting = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: Schema.String,
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type MediaImporting = typeof MediaImporting.Type;

export const MediaLibrarySnapshot = Schema.Struct({
  projectId: ProjectId,
  /** The document fps, for timecodes of audio-only media. */
  fps: EditRational,
  items: Schema.Array(MediaAsset),
  importing: Schema.Array(MediaImporting),
});
export type MediaLibrarySnapshot = typeof MediaLibrarySnapshot.Type;

export const MediaLibraryErrorReason = Schema.Literals([
  "not-found",
  "not-a-media-file",
  "unreadable",
  "not-an-edit-project",
  "copy-failed",
  "different-file",
  "unknown-media",
  "edit-failed",
]);
export type MediaLibraryErrorReason = typeof MediaLibraryErrorReason.Type;

/** `explanation` is shown as is; it never carries tool output. */
export class MediaLibraryError extends Schema.TaggedError<MediaLibraryError>()(
  "MediaLibraryError",
  {
    reason: MediaLibraryErrorReason,
    explanation: Schema.String,
  },
) {
  override get message(): string {
    return this.explanation;
  }
}
