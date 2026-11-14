// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * "Add captions" (S7V-075) writes the one transcript caption track as one change and one undo
 * step; cuts rebuild it in `EditDocumentService.apply` and keep its look (S7V-037). A look picked
 * with no captions adds them in the same change (PO 2026-11-12). S7V-099: a clip already showing
 * captions in its picture is refused until the user confirms (`docs/internals/captions.md`).
 */
import {
  CAPTION_PRESET_NAMES,
  CaptionPresetId,
  CaptionsError,
  type EditCaptionCustom,
  type EditDocument,
  type EditOp,
  type EditOrigin,
  EditUnavailableError,
  type ProjectId,
} from "@t3tools/contracts";
import {
  captionCustomOf,
  captionLookOf,
  captionTrackOps,
  shownCaptionTracks,
  transcriptCaptionTrackOf,
} from "@t3tools/shared/captionWords";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CaptionStillsService from "../export/CaptionStillsService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { describeCaptionCustom, mergeCaptionCustom, sameCaptionCustom } from "./captionCustom.ts";
import { loadCaptionTranscripts } from "./captionTrack.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { ASSEMBLE_FIRST } from "./videoTrack.ts";

const ADDED_CAPTIONS = "Added captions";
/** The engine's look when a caption track names none (`captions_ass.DEFAULT_STYLE`). */
const DEFAULT_PRESET: CaptionPresetId = "s7-neutral";

export interface AddCaptionsResult {
  readonly revision: number;
  readonly captions: number;
  readonly changed: boolean;
}

export interface SetStyleResult extends AddCaptionsResult {
  /** The captions were added from the transcripts in the same change. */
  readonly added: boolean;
  /** The look and the user's own colours, size and place the captions now have. */
  readonly preset: CaptionPresetId;
  readonly custom: EditCaptionCustom;
}

export interface StyleInput {
  /** The look; the current one when missing. */
  readonly preset?: CaptionPresetId | undefined;
  /** Colours, size or place to change, on top of the track's own; the rest are kept. */
  readonly custom?: EditCaptionCustom | undefined;
}

/** The user said to add captions over the ones already in a clip's picture (S7V-099). */
export interface Confirmed {
  readonly confirm?: boolean | undefined;
}

export interface LooksResult {
  readonly revision: number;
  readonly looks: ReadonlyArray<CaptionStillsService.CaptionLookPreview>;
}

const captionCount = (document: EditDocument) =>
  shownCaptionTracks(document).reduce((sum, track) => sum + track.items.length, 0);

const presetOf = (document: EditDocument): CaptionPresetId => {
  const look = captionLookOf(document);
  return CaptionPresetId.literals.find((id) => id === look) ?? DEFAULT_PRESET;
};

const BURNED_IN_QUESTION = "This clip already has captions in the picture. Add more on top?";

export class CaptionTrackService extends Context.Service<
  CaptionTrackService,
  {
    readonly addCaptions: (
      projectId: ProjectId,
      options: EditDocumentService.EditCaller & Confirmed,
    ) => Effect.Effect<AddCaptionsResult, CaptionsError | EditDocumentService.EditApplyError>;
    /** The look and the user's own colours, size and place, as one change and one undo. */
    readonly setStyle: (
      projectId: ProjectId,
      input: StyleInput,
      options: EditDocumentService.EditCaller & Confirmed & { readonly origin: EditOrigin },
    ) => Effect.Effect<SetStyleResult, CaptionsError | EditDocumentService.EditApplyError>;
    /**
     * The four looks with their previews, changing nothing. On an edit with no captions it first
     * asks what adding them would (transcripts, captions already in the picture).
     */
    readonly looks: (
      projectId: ProjectId,
      options: Confirmed,
    ) => Effect.Effect<LooksResult, CaptionsError | EditDocumentService.EditApplyError>;
  }
>()("t3/edit/CaptionTrackService") {}

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const stills = yield* CaptionStillsService.CaptionStillsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The ops that write the transcript caption track, or the plain reason they can't. */
  const transcriptTrackOps = Effect.fn("CaptionTrackService.transcriptTrackOps")(function* (
    projectId: ProjectId,
    document: EditDocument,
    retry: string,
    confirmed: boolean,
  ) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(project)) {
      return yield* new EditUnavailableError({
        projectId,
        reason: "unknown-project",
        explanation: "This project no longer exists.",
      });
    }
    const root = path.resolve(project.value.workspaceRoot);
    const { transcripts, missing, burnedIn } = yield* loadCaptionTranscripts(root, document).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (missing.length > 0) {
      const clips = missing.join(", ");
      return yield* new CaptionsError({
        reason: "no-transcript",
        detail: `Transcribe the clip first: ${clips} has no transcript. Run video_transcribe, then ${retry} again.`,
      });
    }
    if (burnedIn.length > 0 && !confirmed) {
      return yield* new CaptionsError({
        reason: "burned-in",
        detail: `${burnedIn.join(", ")} already shows captions in its picture. Nothing changed. Ask the user: "${BURNED_IN_QUESTION}" If they say yes, ${retry} again with confirm: true.`,
      });
    }
    if (transcripts.size === 0) {
      const noVideo = document.tracks.every(
        (track) => track.kind !== "video" || track.items.length === 0,
      );
      return yield* new CaptionsError({
        reason: "no-clips",
        detail: noVideo
          ? `There is nothing to caption: the timeline has no clip yet. ${ASSEMBLE_FIRST}`
          : "There is nothing to caption: no clip with sound is on the timeline.",
      });
    }
    return captionTrackOps(document, transcripts);
  });

  const addCaptions: CaptionTrackService["Service"]["addCaptions"] = Effect.fn(
    "CaptionTrackService.addCaptions",
  )(function* (projectId, options) {
    const snapshot = yield* edits.read(projectId);
    // Rebuilding captions the user already has is not adding them over the picture's.
    const confirmed =
      options.confirm === true || transcriptCaptionTrackOf(snapshot.document) !== undefined;
    const ops = yield* transcriptTrackOps(projectId, snapshot.document, "add captions", confirmed);
    const after = yield* edits.apply(projectId, ops, {
      origin: "agent",
      baseRevision: snapshot.revision,
      reply: options.reply,
      summary: ADDED_CAPTIONS,
    });
    const track = transcriptCaptionTrackOf(after.document);
    return {
      revision: after.revision,
      captions: track?.items.length ?? 0,
      changed: after.revision !== snapshot.revision,
    };
  });

  const setStyle: CaptionTrackService["Service"]["setStyle"] = Effect.fn(
    "CaptionTrackService.setStyle",
  )(function* (projectId, input, options) {
    const snapshot = yield* edits.read(projectId);
    const { document } = snapshot;
    const preset = input.preset ?? presetOf(document);
    const custom =
      input.custom === undefined
        ? (captionCustomOf(document) ?? {})
        : mergeCaptionCustom(captionCustomOf(document), input.custom);
    const ownCustom = input.custom === undefined ? {} : { custom };
    const name = CAPTION_PRESET_NAMES[preset];
    const own = describeCaptionCustom(custom);
    const ownNote = own === "" ? "" : ` (${own})`;
    const tracks = shownCaptionTracks(document);
    let ops: EditOp[];
    if (tracks.length > 0) {
      ops = tracks
        .filter(
          (track) =>
            (track.style ?? DEFAULT_PRESET) !== preset ||
            (input.custom !== undefined && !sameCaptionCustom(track.custom, custom)),
        )
        .map((track): EditOp => ({
          _tag: "setCaptionStyle",
          trackId: track.id,
          style: preset,
          ...ownCustom,
        }));
      if (ops.length === 0) {
        return {
          revision: snapshot.revision,
          captions: captionCount(document),
          changed: false,
          added: false,
          preset,
          custom,
        };
      }
    } else {
      const trackOps = yield* transcriptTrackOps(
        projectId,
        document,
        "pick the look",
        options.confirm === true,
      );
      const addTrack = trackOps.find(
        (op): op is Extract<EditOp, { _tag: "addTrack" }> => op._tag === "addTrack",
      );
      // No captions show, so `captionTrackOps` adds the transcript track; never a second one.
      const trackId = addTrack!.track.id;
      ops = [
        ...trackOps,
        {
          _tag: "setCaptionStyle",
          trackId,
          style: preset,
          ...(Object.keys(custom).length > 0 ? { custom } : {}),
        },
      ];
    }
    const added = tracks.length === 0;
    const after = yield* edits.apply(projectId, ops, {
      origin: options.origin,
      baseRevision: snapshot.revision,
      reply: options.reply,
      summary: added
        ? `Added captions in the ${name} look${ownNote}`
        : `Changed the caption look to ${name}${ownNote}`,
    });
    return {
      revision: after.revision,
      captions: captionCount(after.document),
      changed: after.revision !== snapshot.revision,
      added,
      preset,
      custom,
    };
  });

  const looks: CaptionTrackService["Service"]["looks"] = Effect.fn("CaptionTrackService.looks")(
    function* (projectId, options) {
      const snapshot = yield* edits.read(projectId);
      if (shownCaptionTracks(snapshot.document).length === 0) {
        yield* transcriptTrackOps(
          projectId,
          snapshot.document,
          "ask for the looks",
          options.confirm === true,
        );
      }
      return { revision: snapshot.revision, looks: yield* stills.previews(projectId) };
    },
  );

  return CaptionTrackService.of({ addCaptions, setStyle, looks });
});

export const layer = Layer.effect(CaptionTrackService, make);
