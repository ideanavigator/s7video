// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * "Add captions" (S7V-075) writes the one transcript caption track as one change and one undo
 * step; cuts rebuild it in `EditDocumentService.apply` and keep its look (S7V-037). A look picked
 * with no captions adds them in the same change (PO 2026-11-12): an empty track would lose it.
 */
import {
  CAPTION_PRESET_NAMES,
  type CaptionPresetId,
  CaptionsError,
  type EditCaptionTrack,
  type EditDocument,
  type EditOp,
  type EditOrigin,
  EditUnavailableError,
  type ProjectId,
} from "@t3tools/contracts";
import { captionTrackOps, transcriptCaptionTrackOf } from "@t3tools/shared/captionWords";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
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
}

/** The tracks whose captions show: the transcript track, and any caption track with items. */
const styledTracks = (document: EditDocument) => {
  const transcript = transcriptCaptionTrackOf(document);
  return document.tracks.filter(
    (track): track is EditCaptionTrack =>
      track.kind === "caption" && (track === transcript || track.items.length > 0),
  );
};

const captionCount = (document: EditDocument) =>
  styledTracks(document).reduce((sum, track) => sum + track.items.length, 0);

export class CaptionTrackService extends Context.Service<
  CaptionTrackService,
  {
    readonly addCaptions: (
      projectId: ProjectId,
      options: EditDocumentService.EditCaller,
    ) => Effect.Effect<AddCaptionsResult, CaptionsError | EditDocumentService.EditApplyError>;
    /** The agent's tool and the Editor's strip (`origin: "timeline"`) both pick a look here. */
    readonly setStyle: (
      projectId: ProjectId,
      preset: CaptionPresetId,
      options: EditDocumentService.EditCaller & { readonly origin: EditOrigin },
    ) => Effect.Effect<SetStyleResult, CaptionsError | EditDocumentService.EditApplyError>;
  }
>()("t3/edit/CaptionTrackService") {}

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The ops that write the transcript caption track, or the plain reason they can't. */
  const transcriptTrackOps = Effect.fn("CaptionTrackService.transcriptTrackOps")(function* (
    projectId: ProjectId,
    document: EditDocument,
    retry: string,
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
    const { transcripts, missing } = yield* loadCaptionTranscripts(root, document).pipe(
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
    if (transcripts.size === 0) {
      const noVideo = snapshot.document.tracks.every(
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
    const ops = yield* transcriptTrackOps(projectId, snapshot.document, "add captions");
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
  )(function* (projectId, preset, options) {
    const snapshot = yield* edits.read(projectId);
    const { document } = snapshot;
    const name = CAPTION_PRESET_NAMES[preset];
    const tracks = styledTracks(document);
    let ops: EditOp[];
    if (tracks.length > 0) {
      ops = tracks
        .filter((track) => (track.style ?? DEFAULT_PRESET) !== preset)
        .map((track): EditOp => ({ _tag: "setCaptionStyle", trackId: track.id, style: preset }));
      if (ops.length === 0) {
        return {
          revision: snapshot.revision,
          captions: captionCount(document),
          changed: false,
          added: false,
        };
      }
    } else {
      const trackOps = yield* transcriptTrackOps(projectId, document, "pick the look");
      const addTrack = trackOps.find(
        (op): op is Extract<EditOp, { _tag: "addTrack" }> => op._tag === "addTrack",
      );
      // No captions show, so `captionTrackOps` adds the transcript track; never a second one.
      const trackId = addTrack!.track.id;
      ops = [...trackOps, { _tag: "setCaptionStyle", trackId, style: preset }];
    }
    const added = tracks.length === 0;
    const after = yield* edits.apply(projectId, ops, {
      origin: options.origin,
      baseRevision: snapshot.revision,
      reply: options.reply,
      summary: added ? `Added captions in the ${name} look` : `Changed the caption look to ${name}`,
    });
    return {
      revision: after.revision,
      captions: captionCount(after.document),
      changed: after.revision !== snapshot.revision,
      added,
    };
  });

  return CaptionTrackService.of({ addCaptions, setStyle });
});

export const layer = Layer.effect(CaptionTrackService, make);
