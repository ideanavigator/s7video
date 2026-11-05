// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Edit operations: the one way the agent, the timeline (S7V-034) and the transcript (S7V-038)
 * change `edit.json`. Every frame is an integer at the document `fps`.
 */
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

import {
  EditAudioItem,
  EditCaptionItem,
  EditCaptionWord,
  EditDocument,
  EditDuck,
  EditId,
  EditMarker,
  EditMedia,
  EditMetadata,
  EditOverlayItem,
  EditOverlayTransform,
  EditStyleRef,
  EditTrack,
  EditVideoItem,
  EditZoom,
} from "./edit.ts";

const Frame = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const FrameCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** An item to insert; a missing id is allocated by the service. */
export const EditNewItem = Schema.Union([
  EditVideoItem.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(EditId) })),
  EditCaptionItem.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(EditId) })),
  EditAudioItem.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(EditId) })),
  EditOverlayItem.mapFields((fields) => ({ ...fields, id: Schema.optionalKey(EditId) })),
]);
export type EditNewItem = typeof EditNewItem.Type;

export const EditSourceRange = Schema.Struct({ in: Frame, duration: FrameCount });
export type EditSourceRange = typeof EditSourceRange.Type;

/** Replaces a video track's items with these source ranges of one media, end to end. */
export const SetKeepRangesOp = Schema.TaggedStruct("setKeepRanges", {
  trackId: EditId,
  mediaId: EditId,
  ranges: Schema.Array(EditSourceRange),
  /** Timeline frame of the first range; 0 when missing. */
  start: Schema.optionalKey(Frame),
});

export const EditNewCaption = EditCaptionItem.mapFields((fields) => ({
  ...fields,
  id: Schema.optionalKey(EditId),
}));

/** Replaces every caption on a caption track. */
export const SetCaptionsOp = Schema.TaggedStruct("setCaptions", {
  trackId: EditId,
  captions: Schema.Array(EditNewCaption),
});

export const InsertItemOp = Schema.TaggedStruct("insertItem", {
  trackId: EditId,
  item: EditNewItem,
  /** Pushes later items on the track right by the new item's duration. */
  ripple: Schema.optionalKey(Schema.Boolean),
});

export const MoveItemOp = Schema.TaggedStruct("moveItem", {
  itemId: EditId,
  /** Another track of the same kind; the item's own track when missing. */
  toTrackId: Schema.optionalKey(EditId),
  start: Frame,
});

/** Moves one edge to a timeline frame; the source `in` follows a start-edge trim. */
export const TrimItemOp = Schema.TaggedStruct("trimItem", {
  itemId: EditId,
  edge: Schema.Literals(["start", "end"]),
  frame: Frame,
});

export const SplitItemOp = Schema.TaggedStruct("splitItem", {
  itemId: EditId,
  atFrame: Frame,
  /** Id for the right-hand part; allocated when missing. */
  newItemId: Schema.optionalKey(EditId),
});

export const DeleteItemOp = Schema.TaggedStruct("deleteItem", {
  itemIds: Schema.Array(EditId),
  /** Closes the gap each deleted item leaves on its track. */
  ripple: Schema.Boolean,
});

/** Puts a removed source range of one media back on a video track, merged with what is kept. */
export const RestoreRangeOp = Schema.TaggedStruct("restoreRange", {
  trackId: EditId,
  mediaId: EditId,
  range: EditSourceRange,
});

/** Sets item properties; `null` removes an optional property. */
export const EditItemProps = Schema.Struct({
  gainDb: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  muted: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  zoom: Schema.optionalKey(Schema.NullOr(EditZoom)),
  fadeInFrames: Schema.optionalKey(Schema.NullOr(Frame)),
  fadeOutFrames: Schema.optionalKey(Schema.NullOr(Frame)),
  linkId: Schema.optionalKey(Schema.NullOr(EditId)),
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  text: Schema.optionalKey(Schema.String),
  words: Schema.optionalKey(Schema.NullOr(Schema.Array(EditCaptionWord))),
  style: Schema.optionalKey(Schema.NullOr(EditStyleRef)),
  transform: Schema.optionalKey(Schema.NullOr(EditOverlayTransform)),
  opacity: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  metadata: Schema.optionalKey(Schema.NullOr(EditMetadata)),
});
export type EditItemProps = typeof EditItemProps.Type;

export const SetItemPropsOp = Schema.TaggedStruct("setItemProps", {
  itemId: EditId,
  props: EditItemProps,
});

export const AddTrackOp = Schema.TaggedStruct("addTrack", {
  track: EditTrack,
  /** Position in `tracks`; appended when missing. */
  index: Schema.optionalKey(Frame),
});

export const SetCaptionStyleOp = Schema.TaggedStruct("setCaptionStyle", {
  trackId: EditId,
  style: EditStyleRef,
});

export const EditTrackProps = Schema.Struct({
  role: Schema.optionalKey(Schema.NullOr(Schema.String)),
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  muted: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  locked: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  duck: Schema.optionalKey(Schema.NullOr(EditDuck)),
  metadata: Schema.optionalKey(Schema.NullOr(EditMetadata)),
});
export type EditTrackProps = typeof EditTrackProps.Type;

/** Track settings such as music ducking (S7V-036). */
export const SetTrackPropsOp = Schema.TaggedStruct("setTrackProps", {
  trackId: EditId,
  props: EditTrackProps,
});

/** Adds or replaces a media entry (import, S7V-025). */
export const PutMediaOp = Schema.TaggedStruct("putMedia", { media: EditMedia });

/** Removes a media entry no item uses. */
export const RemoveMediaOp = Schema.TaggedStruct("removeMedia", { mediaId: EditId });

export const SetMarkersOp = Schema.TaggedStruct("setMarkers", {
  markers: Schema.Array(EditMarker),
});

export const EditOp = Schema.Union([
  SetKeepRangesOp,
  SetCaptionsOp,
  InsertItemOp,
  MoveItemOp,
  TrimItemOp,
  SplitItemOp,
  DeleteItemOp,
  RestoreRangeOp,
  SetItemPropsOp,
  AddTrackOp,
  SetCaptionStyleOp,
  SetTrackPropsOp,
  PutMediaOp,
  RemoveMediaOp,
  SetMarkersOp,
]);
export type EditOp = typeof EditOp.Type;

export const EditOrigin = Schema.Literals(["agent", "timeline", "transcript"]);
export type EditOrigin = typeof EditOrigin.Type;

export const EditProjectInput = Schema.Struct({ projectId: ProjectId });
export type EditProjectInput = typeof EditProjectInput.Type;

export const EditSnapshot = Schema.Struct({
  revision: Schema.Int,
  document: EditDocument,
  canUndo: Schema.Boolean,
  canRedo: Schema.Boolean,
});
export type EditSnapshot = typeof EditSnapshot.Type;

export const EditApplyInput = Schema.Struct({
  projectId: ProjectId,
  baseRevision: Schema.Int,
  origin: EditOrigin,
  ops: Schema.Array(EditOp),
});
export type EditApplyInput = typeof EditApplyInput.Type;

/** Why an edit request could not run; validation and conflicts have their own errors. */
export class EditUnavailableError extends Schema.TaggedError<EditUnavailableError>()(
  "EditUnavailableError",
  {
    projectId: ProjectId,
    reason: Schema.Literals([
      "unknown-project",
      "not-an-edit-project",
      "unsupported-version",
      "unreadable",
      "write-failed",
      "media-in-tracked-folder",
      "nothing-to-undo",
      "nothing-to-redo",
      "checkpoint-failed",
    ]),
    explanation: Schema.String,
  },
) {
  override get message(): string {
    return this.explanation;
  }
}

/** An op that cannot apply to the current document (a missing item, a split outside it). */
export class EditOpError extends Schema.TaggedError<EditOpError>()("EditOpError", {
  opIndex: Schema.Int,
  op: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  explanation: Schema.String,
}) {
  override get message(): string {
    return this.explanation;
  }
}
