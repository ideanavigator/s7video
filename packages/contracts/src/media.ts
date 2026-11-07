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

/** What `/api/assets` serves for one media; `peaks` and `filmstrip` name one file each by `part`. */
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

/** One kind of media data: `none` means the media has nothing to show (no sound, no picture). */
export const MediaDataPart = Schema.Literals(["ready", "pending", "none"]);
export type MediaDataPart = typeof MediaDataPart.Type;

/**
 * The timeline's waveform and filmstrip (S7V-035), shaped like `proxy`. The waveform is ready
 * before the filmstrip, so each part says on its own whether it can be fetched yet.
 */
export const MediaDataState = Schema.Struct({
  status: Schema.Literals(["none", "preparing", "ready", "failed"]),
  jobId: Schema.optional(EngineJobId),
  /** 0..1 while preparing. */
  progress: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  peaks: MediaDataPart,
  filmstrip: MediaDataPart,
});
export type MediaDataState = typeof MediaDataState.Type;

/**
 * `part` names one file of a `peaks` or `filmstrip` variant: `index`, a peaks level (`p1024`) or a
 * filmstrip sheet (`f16s-3`: the 16 s level's third sheet). Other variants take no `part`.
 */
export const MediaDataPartName = Schema.String.check(
  Schema.isPattern(/^(?:index|p[1-9][0-9]{1,6}|f[1-9][0-9]{0,3}s-[1-9][0-9]{0,4})$/u),
);
export type MediaDataPartName = typeof MediaDataPartName.Type;

const VersionOne = Schema.Literal(1);

/**
 * `peaks` part `index`. Level `p<samplesPerPeak>` holds `count` little-endian float32
 * `[min, max]` pairs; pair `i` covers samples `[i, i + 1) * samplesPerPeak` from the first audio
 * sample, which sits `offsetSamples` after the video's first frame. `audio: false`: no sound.
 */
export const MediaPeaksIndex = Schema.Struct({
  version: VersionOne,
  audio: Schema.Boolean,
  sampleRate: PositiveInt,
  channels: Schema.optional(PositiveInt),
  durationSamples: Schema.optional(NonNegativeInt),
  offsetSamples: Schema.optional(Schema.Int),
  levels: Schema.Array(
    Schema.Struct({ samplesPerPeak: PositiveInt, count: NonNegativeInt, file: Schema.String }),
  ),
});
export type MediaPeaksIndex = typeof MediaPeaksIndex.Type;

/**
 * `filmstrip` part `index`. Tile `i` of a level is `frames[i]` (an integer frame at `rate`, the
 * media's own rate, from its first frame) and sits on sheet `floor(i / (columns * rows)) + 1`, at
 * row `floor(i / columns) % rows`, column `i % columns`, each tile `tileWidth` x `tileHeight` px.
 */
export const MediaFilmstripIndex = Schema.Struct({
  version: VersionOne,
  video: Schema.Boolean,
  rate: EditRational,
  tileWidth: PositiveInt,
  tileHeight: PositiveInt,
  columns: PositiveInt,
  rows: PositiveInt,
  levels: Schema.Array(
    Schema.Struct({
      level: Schema.String,
      secondsPerTile: PositiveInt,
      framesPerTile: PositiveInt,
      sheets: Schema.Array(Schema.String),
      frames: Schema.Array(NonNegativeInt),
    }),
  ),
});
export type MediaFilmstripIndex = typeof MediaFilmstripIndex.Type;

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
  /** Always sent by the server; optional so lists built before S7V-035 still decode. */
  mediaData: Schema.optional(MediaDataState),
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
