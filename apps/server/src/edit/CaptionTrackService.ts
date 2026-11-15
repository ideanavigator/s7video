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
  type CaptionPosition,
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
  captionItemsFor,
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
import {
  describeCaptionCustom,
  mergeCaptionCustom,
  missingLookPart,
  sameCaptionCustom,
} from "./captionCustom.ts";
import { captionedMedia, type CaptionTranscripts, loadCaptionTranscripts } from "./captionTrack.ts";
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
  /** The look's own colours, size and place in editing words, as the version note says them. */
  readonly described: string;
  /** Clips that show their own captions and were left uncaptioned, by the names the user knows. */
  readonly uncaptioned: ReadonlyArray<string>;
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
  /** As in `SetStyleResult`. */
  readonly uncaptioned: ReadonlyArray<string>;
}

const captionCount = (document: EditDocument) =>
  shownCaptionTracks(document).reduce((sum, track) => sum + track.items.length, 0);

const presetOf = (document: EditDocument): CaptionPresetId => {
  const look = captionLookOf(document);
  return CaptionPresetId.literals.find((id) => id === look) ?? DEFAULT_PRESET;
};

/** A clip as the user knows it: its label, or its file's name. */
const clipName = (document: EditDocument, id: string) => {
  const media = document.media.find((entry) => entry.id === id);
  return media?.label ?? (media?.path ?? media?.reference ?? id).split(/[\\/]/u).at(-1) ?? id;
};

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const placeWords = (position: CaptionPosition) =>
  position === "middle" ? "in the middle" : `at the ${position}`;

/**
 * Captions about to be added over a clip whose picture shows its own (S7V-099): the question for
 * the user, naming the clip, with choices that fit where the new captions would go, and what the
 * agent does with each answer (UX guide rule 9).
 */
const burnedInRefusal = (
  document: EditDocument,
  pending: CaptionTranscripts["burnedIn"],
  retry: string,
  position: CaptionPosition,
) => {
  const names = [...pending.keys()].map((id) => clipName(document, id));
  const region = [...pending.values()].find((entry) => entry !== undefined);
  const where = region === undefined ? null : region.y0 + region.y1 < 1 ? "top" : "bottom";
  const other = where === "top" ? "bottom" : "top";
  const subject = `${listed(names)} already ${names.length === 1 ? "has" : "have"} captions`;
  const question =
    where === null
      ? `${subject} in the picture. Add ours anyway, or leave it as it is?`
      : where !== position
        ? `${subject} near the ${where}; ours would be ${placeWords(position)}. Add them, or leave it as it is?`
        : `${subject} near the ${where}. Add ours at the ${other}, add them anyway, or leave it as it is?`;
  const atOther =
    where === position
      ? ` If they choose the ${other}, call video_caption_style with confirm: true and custom {"position": "${other}"}.`
      : "";
  return new CaptionsError({
    reason: "burned-in",
    detail: `${listed(names)} already ${names.length === 1 ? "shows" : "show"} captions in the picture. Nothing changed. Ask the user: "${question}"${atOther} If they say add them, ${retry} again with confirm: true. If they say leave it, change nothing.`,
  });
};

/**
 * Burned-in clips that adding captions would caption (speech in their placed part) and the
 * transcript track doesn't yet: those need the user's yes.
 */
const unconfirmed = (loaded: CaptionTranscripts, document: EditDocument) => {
  const captioned = captionedMedia(document);
  return new Map(
    [...loaded.burnedIn].filter(([media]) => {
      const transcript = loaded.transcripts.get(media);
      return (
        !captioned.has(media) &&
        transcript !== undefined &&
        captionItemsFor(document, new Map([[media, transcript]])).length > 0
      );
    }),
  );
};

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

  const transcriptsOf = Effect.fn("CaptionTrackService.transcriptsOf")(function* (
    projectId: ProjectId,
    document: EditDocument,
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
    return yield* loadCaptionTranscripts(root, document).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });

  /**
   * The ops that write the transcript caption track, or the plain reason they can't. A clip that
   * already shows captions counts as a yes only once the track captions it (S7V-099).
   */
  const transcriptTrackOps = Effect.fn("CaptionTrackService.transcriptTrackOps")(function* (
    projectId: ProjectId,
    document: EditDocument,
    retry: string,
    confirmed: boolean,
    position: CaptionPosition,
  ) {
    const loaded = yield* transcriptsOf(projectId, document);
    const { transcripts, missing } = loaded;
    if (missing.length > 0) {
      const clips = missing.join(", ");
      return yield* new CaptionsError({
        reason: "no-transcript",
        detail: `Transcribe the clip first: ${clips} has no transcript. Run video_transcribe, then ${retry} again.`,
      });
    }
    const pending = unconfirmed(loaded, document);
    if (pending.size > 0 && !confirmed) {
      return yield* burnedInRefusal(document, pending, retry, position);
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
    const ops = yield* transcriptTrackOps(
      projectId,
      snapshot.document,
      "add captions",
      options.confirm === true,
      captionCustomOf(snapshot.document)?.position ?? "bottom",
    );
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
    // A size asked for now is said against the size before ("a bit smaller" from 1.4 to 1.2).
    const sizeBefore = captionCustomOf(document)?.size ?? 1;
    const own = describeCaptionCustom(
      custom,
      preset,
      input.custom?.size === undefined ? undefined : sizeBefore,
    );
    const ownNote = own === "" ? "" : ` (${own})`;
    const lacking = input.custom === undefined ? null : missingLookPart(input.custom, preset);
    if (lacking !== null) return yield* new CaptionsError({ reason: "look-part", detail: lacking });
    const tracks = shownCaptionTracks(document);
    let ops: EditOp[];
    let uncaptioned: ReadonlyArray<string> = [];
    if (tracks.length > 0) {
      // A restyle adds no captions, so it never asks. A clip placed later that shows its own
      // stays uncaptioned and is named in the reply; with the user's yes, this change captions it.
      const pending: CaptionTranscripts["burnedIn"] =
        transcriptCaptionTrackOf(document) === undefined
          ? new Map()
          : unconfirmed(yield* transcriptsOf(projectId, document), document);
      const confirmed = pending.size > 0 && options.confirm === true;
      uncaptioned = confirmed ? [] : [...pending.keys()].map((id) => clipName(document, id));
      const recaptioned = confirmed
        ? yield* transcriptTrackOps(projectId, document, "pick the look", true, "bottom")
        : [];
      const restyled = tracks
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
      ops = [...recaptioned, ...restyled];
      if (ops.length === 0) {
        return {
          revision: snapshot.revision,
          captions: captionCount(document),
          changed: false,
          added: false,
          preset,
          custom,
          described: own,
          uncaptioned,
        };
      }
    } else {
      const trackOps = yield* transcriptTrackOps(
        projectId,
        document,
        "pick the look",
        options.confirm === true,
        custom.position ?? "bottom",
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
      described: own,
      uncaptioned,
    };
  });

  const looks: CaptionTrackService["Service"]["looks"] = Effect.fn("CaptionTrackService.looks")(
    function* (projectId, options) {
      const snapshot = yield* edits.read(projectId);
      const { document } = snapshot;
      let uncaptioned: ReadonlyArray<string> = [];
      if (shownCaptionTracks(document).length === 0) {
        yield* transcriptTrackOps(
          projectId,
          document,
          "ask for the looks",
          options.confirm === true,
          captionCustomOf(document)?.position ?? "bottom",
        );
      } else if (transcriptCaptionTrackOf(document) !== undefined) {
        // The looks restyle captions that exist; a clip placed later with its own is only named.
        const pending = unconfirmed(yield* transcriptsOf(projectId, document), document);
        uncaptioned = [...pending.keys()].map((id) => clipName(document, id));
      }
      return {
        revision: snapshot.revision,
        looks: yield* stills.previews(projectId),
        uncaptioned,
      };
    },
  );

  return CaptionTrackService.of({ addCaptions, setStyle, looks });
});

export const layer = Layer.effect(CaptionTrackService, make);
