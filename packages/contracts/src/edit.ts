// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * `edit.json` v1, the source of truth for an edit (ADR-005). Times are integer frames at `fps`.
 * The engine validates with the JSON Schema exported from `EditDocument` (`pnpm edit:schema`)
 * plus the same rules in `packages/engine/src/s7engine/edit_schema.py`; keep them in step.
 */
import * as Schema from "effect/Schema";

export const EDIT_DOCUMENT_VERSION = 1;

const Frame = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const FrameCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** Ids are short and safe in file names, refs and OTIO metadata. */
export const EditId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u));
export type EditId = typeof EditId.Type;

/** A caption style: one of ours (`s7-neutral`) or a user style under `styles/`, never outside it. */
export const EditStyleRef = Schema.String.check(
  Schema.isPattern(/^(?!.*\/\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u),
);
export type EditStyleRef = typeof EditStyleRef.Type;

export const EditMetadata = Schema.Record(Schema.String, Schema.Unknown);
export type EditMetadata = typeof EditMetadata.Type;

export const EditRational = Schema.Struct({ num: PositiveInt, den: PositiveInt });
export type EditRational = typeof EditRational.Type;

export const EditCanvas = Schema.Struct({ width: PositiveInt, height: PositiveInt });
export type EditCanvas = typeof EditCanvas.Type;

/** The shapes a user can ask for (PO, 2026-11-06); a new edit takes its first clip's own shape. */
export const EditAspectRatio = Schema.Literals(["9:16", "16:9", "1:1", "4:5", "4:3"]);
export type EditAspectRatio = typeof EditAspectRatio.Type;

export const EditMediaKind = Schema.Literals(["video", "audio", "image"]);
export type EditMediaKind = typeof EditMediaKind.Type;

/** sha256 over the first and last MiB of the file, plus its size in bytes. */
export const EditMediaFingerprint = Schema.Struct({
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  size: Frame,
});
export type EditMediaFingerprint = typeof EditMediaFingerprint.Type;

/**
 * What the engine's probe found. `durationFrames` is the media's length in document frames,
 * converted from its real presentation timestamps at import; still images have none.
 */
export const EditMediaProbe = Schema.Struct({
  durationFrames: Schema.optionalKey(Frame),
  hasVideo: Schema.Boolean,
  hasAudio: Schema.Boolean,
  width: Schema.optionalKey(PositiveInt),
  height: Schema.optionalKey(PositiveInt),
  fps: Schema.optionalKey(EditRational),
  variableFrameRate: Schema.optionalKey(Schema.Boolean),
  sampleRate: Schema.optionalKey(PositiveInt),
  audioChannels: Schema.optionalKey(PositiveInt),
  codec: Schema.optionalKey(Schema.String),
});
export type EditMediaProbe = typeof EditMediaProbe.Type;

/** Exactly one of `path` (relative to the project) and `reference` (absolute, never copied). */
export const EditMedia = Schema.Struct({
  id: EditId,
  kind: EditMediaKind,
  path: Schema.optionalKey(Schema.String),
  reference: Schema.optionalKey(Schema.String),
  fingerprint: EditMediaFingerprint,
  probe: EditMediaProbe,
  label: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(EditMetadata),
});
export type EditMedia = typeof EditMedia.Type;

/** A punch-in over a whole video item; the anchor is normalised to the frame (S7V-037). */
export const EditZoom = Schema.Struct({
  scale: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  anchorX: UnitInterval,
  anchorY: UnitInterval,
  rampFrames: Frame,
});
export type EditZoom = typeof EditZoom.Type;

export const EditVideoItem = Schema.Struct({
  id: EditId,
  media: EditId,
  start: Frame,
  duration: FrameCount,
  in: Frame,
  /** Gain in dB on the clip's own audio, relative to the source level; missing means 0. */
  gainDb: Schema.optionalKey(Schema.Finite),
  muted: Schema.optionalKey(Schema.Boolean),
  zoom: Schema.optionalKey(EditZoom),
  /** Items sharing a link id move, trim and split together (S7V-034). */
  linkId: Schema.optionalKey(EditId),
  label: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(EditMetadata),
});
export type EditVideoItem = typeof EditVideoItem.Type;

/** One spoken word, in timeline frames, inside its caption item. */
export const EditCaptionWord = Schema.Struct({
  text: Schema.String,
  start: Frame,
  duration: FrameCount,
});
export type EditCaptionWord = typeof EditCaptionWord.Type;

export const EditCaptionItem = Schema.Struct({
  id: EditId,
  start: Frame,
  duration: FrameCount,
  text: Schema.String,
  words: Schema.optionalKey(Schema.Array(EditCaptionWord)),
  /** Overrides the track's style for this caption. */
  style: Schema.optionalKey(EditStyleRef),
  metadata: Schema.optionalKey(EditMetadata),
});
export type EditCaptionItem = typeof EditCaptionItem.Type;

/** Sound effects and music. Missing gain and fades mean 0. */
export const EditAudioItem = Schema.Struct({
  id: EditId,
  media: EditId,
  start: Frame,
  duration: FrameCount,
  in: Frame,
  /**
   * Gain in dB relative to the file's own level (0 plays it as recorded). Levels relative to the
   * voice (S7V-036 presets) are converted to this by the tool that places the item.
   */
  gainDb: Schema.optionalKey(Schema.Finite),
  fadeInFrames: Schema.optionalKey(Frame),
  fadeOutFrames: Schema.optionalKey(Frame),
  linkId: Schema.optionalKey(EditId),
  label: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(EditMetadata),
});
export type EditAudioItem = typeof EditAudioItem.Type;

/** Position and size are normalised to the canvas; `x`/`y` place the overlay's centre. */
export const EditOverlayTransform = Schema.Struct({
  x: UnitInterval,
  y: UnitInterval,
  scale: Schema.Finite.check(Schema.isGreaterThan(0)),
  rotationDeg: Schema.optionalKey(Schema.Finite),
});
export type EditOverlayTransform = typeof EditOverlayTransform.Type;

/** An image, a video or a text card drawn over the video: exactly one of `media` and `text`. */
export const EditOverlayItem = Schema.Struct({
  id: EditId,
  media: Schema.optionalKey(EditId),
  text: Schema.optionalKey(Schema.String),
  start: Frame,
  duration: FrameCount,
  in: Schema.optionalKey(Frame),
  transform: Schema.optionalKey(EditOverlayTransform),
  opacity: Schema.optionalKey(UnitInterval),
  fadeInFrames: Schema.optionalKey(Frame),
  fadeOutFrames: Schema.optionalKey(Frame),
  style: Schema.optionalKey(EditStyleRef),
  label: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(EditMetadata),
});
export type EditOverlayItem = typeof EditOverlayItem.Type;

export const EditFrameRange = Schema.Struct({ start: Frame, end: Frame });
export type EditFrameRange = typeof EditFrameRange.Type;

/** Fixed-curve ducking of a music track under speech (S7V-036). */
export const EditDuck = Schema.Struct({
  depthDb: Schema.Finite.check(Schema.isLessThanOrEqualTo(0)),
  attackFrames: Frame,
  releaseFrames: Frame,
  ranges: Schema.Array(EditFrameRange),
});
export type EditDuck = typeof EditDuck.Type;

const trackFields = {
  id: EditId,
  role: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  muted: Schema.optionalKey(Schema.Boolean),
  locked: Schema.optionalKey(Schema.Boolean),
  metadata: Schema.optionalKey(EditMetadata),
};

export const EditVideoTrack = Schema.Struct({
  kind: Schema.Literal("video"),
  ...trackFields,
  items: Schema.Array(EditVideoItem),
});
export type EditVideoTrack = typeof EditVideoTrack.Type;

export const EditCaptionTrack = Schema.Struct({
  kind: Schema.Literal("caption"),
  ...trackFields,
  style: Schema.optionalKey(EditStyleRef),
  items: Schema.Array(EditCaptionItem),
});
export type EditCaptionTrack = typeof EditCaptionTrack.Type;

export const EditSfxTrack = Schema.Struct({
  kind: Schema.Literal("sfx"),
  ...trackFields,
  items: Schema.Array(EditAudioItem),
});
export type EditSfxTrack = typeof EditSfxTrack.Type;

export const EditMusicTrack = Schema.Struct({
  kind: Schema.Literal("music"),
  ...trackFields,
  duck: Schema.optionalKey(EditDuck),
  items: Schema.Array(EditAudioItem),
});
export type EditMusicTrack = typeof EditMusicTrack.Type;

export const EditOverlayTrack = Schema.Struct({
  kind: Schema.Literal("overlay"),
  ...trackFields,
  items: Schema.Array(EditOverlayItem),
});
export type EditOverlayTrack = typeof EditOverlayTrack.Type;

export const EditTrack = Schema.Union([
  EditVideoTrack,
  EditCaptionTrack,
  EditSfxTrack,
  EditMusicTrack,
  EditOverlayTrack,
]);
export type EditTrack = typeof EditTrack.Type;
export type EditTrackKind = EditTrack["kind"];
export type EditItem = EditTrack["items"][number];

export const EditMarkerColor = Schema.Literals([
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "magenta",
  "pink",
  "black",
  "white",
]);
export type EditMarkerColor = typeof EditMarkerColor.Type;

export const EditMarker = Schema.Struct({
  id: EditId,
  start: Frame,
  duration: Frame,
  label: Schema.String,
  color: Schema.optionalKey(EditMarkerColor),
});
export type EditMarker = typeof EditMarker.Type;

export const EditDocument = Schema.Struct({
  version: Schema.Literal(EDIT_DOCUMENT_VERSION),
  fps: EditRational,
  canvas: EditCanvas,
  media: Schema.Array(EditMedia),
  tracks: Schema.Array(EditTrack),
  markers: Schema.Array(EditMarker),
  metadata: EditMetadata,
});
export type EditDocument = typeof EditDocument.Type;

/** Decoding and the exported JSON Schema both reject unknown properties. */
const EDIT_SCHEMA_PARSE_OPTIONS = { onExcessProperty: "error", errors: "all" } as const;

export const EditValidationReason = Schema.Literals([
  "version",
  "schema",
  "frame",
  "duplicate-id",
  "unknown-media",
  "source-range",
  "overlap",
  "media-location",
  "overlay-content",
  "word-range",
  "fade-range",
  "duck-range",
]);
export type EditValidationReason = typeof EditValidationReason.Type;

export const EditValidationIssue = Schema.Struct({
  /** The item, track, media or marker id the problem is on; null when it is the document. */
  itemId: Schema.NullOr(Schema.String),
  reason: EditValidationReason,
  explanation: Schema.String,
});
export type EditValidationIssue = typeof EditValidationIssue.Type;

export class EditValidationError extends Schema.TaggedError<EditValidationError>()(
  "EditValidationError",
  {
    itemId: Schema.NullOr(Schema.String),
    reason: EditValidationReason,
    explanation: Schema.String,
  },
) {
  override get message(): string {
    return this.explanation;
  }
}

export class EditConflict extends Schema.TaggedError<EditConflict>()("EditConflict", {
  baseRevision: Schema.Int,
  currentRevision: Schema.Int,
}) {
  override get message(): string {
    return `The edit changed (now revision ${this.currentRevision}, you had ${this.baseRevision}). Fetch it again and retry.`;
  }
}

const FRAME_KEYS = [
  "start",
  "duration",
  "in",
  "fadeInFrames",
  "fadeOutFrames",
  "durationFrames",
  "rampFrames",
  "attackFrames",
  "releaseFrames",
  "end",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown, fallback: string | null): string | null =>
  isRecord(value) && typeof value.id === "string" ? value.id : fallback;

const issue = (
  itemId: string | null,
  reason: EditValidationReason,
  explanation: string,
): EditValidationIssue => ({ itemId, reason, explanation });

const label = (id: string | null) => (id === null ? "The edit" : `"${id}"`);

/** Finds float or negative frame numbers before schema decoding, naming the item they are on. */
function frameIssues(raw: unknown): EditValidationIssue[] {
  const issues: EditValidationIssue[] = [];
  const check = (value: unknown, owner: string | null) => {
    if (!isRecord(value)) return;
    for (const key of FRAME_KEYS) {
      const frame = value[key];
      if (typeof frame !== "number") continue;
      if (!Number.isInteger(frame) || frame < 0) {
        issues.push(
          issue(
            owner,
            "frame",
            `${label(owner)} has ${key} ${frame}. Times are whole frame numbers, 0 or more.`,
          ),
        );
      }
    }
  };
  if (!isRecord(raw)) return issues;
  for (const media of Array.isArray(raw.media) ? raw.media : []) {
    if (isRecord(media)) check(media.probe, idOf(media, null));
  }
  for (const track of Array.isArray(raw.tracks) ? raw.tracks : []) {
    if (!isRecord(track)) continue;
    const trackId = idOf(track, null);
    if (isRecord(track.duck)) {
      check(track.duck, trackId);
      for (const range of Array.isArray(track.duck.ranges) ? track.duck.ranges : []) {
        check(range, trackId);
      }
    }
    for (const item of Array.isArray(track.items) ? track.items : []) {
      const itemId = idOf(item, trackId);
      check(item, itemId);
      if (isRecord(item)) {
        check(item.zoom, itemId);
        for (const word of Array.isArray(item.words) ? item.words : []) check(word, itemId);
      }
    }
  }
  for (const marker of Array.isArray(raw.markers) ? raw.markers : []) {
    check(marker, idOf(marker, null));
  }
  return issues;
}

/** The nearest object along an issue path that has an id names the problem. */
function ownerAtPath(raw: unknown, path: ReadonlyArray<PropertyKey>): string | null {
  let owner: string | null = null;
  let node: unknown = raw;
  for (const key of path) {
    if (!isRecord(node) && !Array.isArray(node)) break;
    node = (node as Record<PropertyKey, unknown>)[key as never];
    owner = idOf(node, owner);
  }
  return owner;
}

const standardDocument = Schema.toStandardSchemaV1(EditDocument, {
  parseOptions: EDIT_SCHEMA_PARSE_OPTIONS,
});

function schemaIssues(raw: unknown): EditValidationIssue[] {
  const result = standardDocument["~standard"].validate(raw);
  if (result instanceof Promise) throw new Error("EditDocument decoding must be synchronous.");
  if (result.issues === undefined) return [];
  return result.issues.map((failure) => {
    const path = (failure.path ?? []).map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
    );
    const owner = ownerAtPath(raw, path);
    const where = path.length === 0 ? "" : ` at ${path.map(String).join(".")}`;
    return issue(owner, "schema", `${label(owner)} is not valid${where}: ${failure.message}.`);
  });
}

/** Rules a JSON Schema cannot state: ids, references, ranges and overlaps. */
function semanticIssues(document: EditDocument): EditValidationIssue[] {
  const issues: EditValidationIssue[] = [];
  const seen = new Set<string>();
  const claim = (id: string) => {
    if (seen.has(id)) {
      issues.push(issue(id, "duplicate-id", `${label(id)} is used as an id more than once.`));
    }
    seen.add(id);
  };
  const media = new Map<string, EditMedia>();
  for (const entry of document.media) {
    claim(entry.id);
    media.set(entry.id, entry);
    const hasPath = entry.path !== undefined;
    const hasReference = entry.reference !== undefined;
    if (hasPath === hasReference) {
      issues.push(
        issue(
          entry.id,
          "media-location",
          `Media ${label(entry.id)} needs exactly one of a project path or an outside reference.`,
        ),
      );
    } else if (
      hasPath &&
      (entry.path!.length === 0 ||
        entry.path!.startsWith("/") ||
        entry.path!.split(/[\\/]/u).some((part) => part === ".."))
    ) {
      issues.push(
        issue(
          entry.id,
          "media-location",
          `Media ${label(entry.id)} has a path outside the project. Use a path inside it, or a reference.`,
        ),
      );
    } else if (hasReference && !entry.reference!.startsWith("/")) {
      issues.push(
        issue(
          entry.id,
          "media-location",
          `Media ${label(entry.id)} has a reference that is not a full path.`,
        ),
      );
    }
  }
  for (const marker of document.markers) claim(marker.id);

  for (const track of document.tracks) {
    claim(track.id);
    if (track.kind === "music" && track.duck !== undefined) {
      for (const range of track.duck.ranges) {
        if (range.end <= range.start) {
          issues.push(
            issue(
              track.id,
              "duck-range",
              `Track ${label(track.id)} has a ducking range that ends at or before it starts (${range.start} to ${range.end}).`,
            ),
          );
        }
      }
    }
    const items: ReadonlyArray<EditItem> = track.items;
    for (const item of items) {
      claim(item.id);
      const end = item.start + item.duration;
      const mediaId = "media" in item ? item.media : undefined;
      if (track.kind === "overlay" && "text" in item === (mediaId !== undefined)) {
        issues.push(
          issue(
            item.id,
            "overlay-content",
            `Overlay ${label(item.id)} needs exactly one of a media file or text.`,
          ),
        );
      }
      if (mediaId !== undefined) {
        const source = media.get(mediaId);
        if (source === undefined) {
          issues.push(
            issue(
              item.id,
              "unknown-media",
              `Item ${label(item.id)} uses media "${mediaId}", which is not in this project.`,
            ),
          );
        } else {
          const sourceIn = "in" in item && item.in !== undefined ? item.in : 0;
          const available = source.probe.durationFrames;
          if (available !== undefined && sourceIn + item.duration > available) {
            issues.push(
              issue(
                item.id,
                "source-range",
                `Item ${label(item.id)} reads frames ${sourceIn} to ${sourceIn + item.duration}, but media "${mediaId}" has only ${available}.`,
              ),
            );
          }
        }
      }
      if ("fadeInFrames" in item || "fadeOutFrames" in item) {
        const fades = (item.fadeInFrames ?? 0) + (item.fadeOutFrames ?? 0);
        if (fades > item.duration) {
          issues.push(
            issue(
              item.id,
              "fade-range",
              `Item ${label(item.id)} fades for ${fades} frames but lasts only ${item.duration}.`,
            ),
          );
        }
      }
      if ("words" in item && item.words !== undefined) {
        for (const word of item.words) {
          if (word.start < item.start || word.start + word.duration > end) {
            issues.push(
              issue(
                item.id,
                "word-range",
                `Caption ${label(item.id)} has the word "${word.text}" outside its own time.`,
              ),
            );
            break;
          }
        }
      }
    }
    const ordered = [...items].sort(
      (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (previous.start + previous.duration > current.start) {
        issues.push(
          issue(
            current.id,
            "overlap",
            `Item ${label(current.id)} overlaps ${label(previous.id)} on track ${label(track.id)}. Items on one track cannot share frames.`,
          ),
        );
      }
    }
  }
  return issues;
}

export type EditValidationResult =
  | { readonly ok: true; readonly document: EditDocument }
  | { readonly ok: false; readonly issues: ReadonlyArray<EditValidationIssue> };

/**
 * Validates a parsed `edit.json` at the current version. Checks run in a fixed order (version,
 * frames, schema, then semantic rules) so the engine reports the same first problem.
 */
export function validateEditDocument(raw: unknown): EditValidationResult {
  const version = isRecord(raw) ? raw.version : undefined;
  if (version !== EDIT_DOCUMENT_VERSION) {
    return {
      ok: false,
      issues: [
        issue(
          null,
          "version",
          typeof version === "number" && Number.isInteger(version) && version > 0
            ? `This edit uses format version ${version}; this app reads version ${EDIT_DOCUMENT_VERSION}.`
            : "This file has no valid edit format version.",
        ),
      ],
    };
  }
  const frames = frameIssues(raw);
  if (frames.length > 0) return { ok: false, issues: frames };
  const structural = schemaIssues(raw);
  if (structural.length > 0) return { ok: false, issues: structural };
  const document = raw as EditDocument;
  const semantic = semanticIssues(document);
  return semantic.length > 0 ? { ok: false, issues: semantic } : { ok: true, document };
}

export const editValidationError = (issues: ReadonlyArray<EditValidationIssue>) => {
  const first = issues[0] ?? issue(null, "schema", "The edit is not valid.");
  return new EditValidationError(first);
};

/** A new, empty edit at the given rate and size. */
export function emptyEditDocument(input: {
  readonly fps: EditRational;
  readonly canvas: EditCanvas;
}): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    fps: input.fps,
    canvas: input.canvas,
    media: [],
    tracks: [],
    markers: [],
    metadata: {},
  };
}
