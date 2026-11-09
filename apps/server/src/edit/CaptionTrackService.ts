// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * "Add captions" (S7V-075): writes the edit's caption track from the cached transcripts of the
 * clips on the video track, as one change ("Added captions"), so it makes one version and one
 * undo step. Asking again rebuilds the same track; there is never a second one. Later cuts keep
 * it in step inside `EditDocumentService.apply`.
 */
import { CaptionsError, EditUnavailableError, type ProjectId } from "@t3tools/contracts";
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

const ADDED_CAPTIONS = "Added captions";

export interface AddCaptionsResult {
  readonly revision: number;
  readonly captions: number;
  readonly changed: boolean;
}

export class CaptionTrackService extends Context.Service<
  CaptionTrackService,
  {
    readonly addCaptions: (
      projectId: ProjectId,
      options: EditDocumentService.EditCaller,
    ) => Effect.Effect<AddCaptionsResult, CaptionsError | EditDocumentService.EditApplyError>;
  }
>()("t3/edit/CaptionTrackService") {}

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const addCaptions: CaptionTrackService["Service"]["addCaptions"] = Effect.fn(
    "CaptionTrackService.addCaptions",
  )(function* (projectId, options) {
    const snapshot = yield* edits.read(projectId);
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(project)) {
      return yield* new EditUnavailableError({
        projectId,
        reason: "unknown-project",
        explanation: "This project no longer exists.",
      });
    }
    const root = path.resolve(project.value.workspaceRoot);
    const { transcripts, missing } = yield* loadCaptionTranscripts(root, snapshot.document).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (missing.length > 0) {
      const clips = missing.join(", ");
      return yield* new CaptionsError({
        reason: "no-transcript",
        detail: `Transcribe the clip first: ${clips} has no transcript. Run video_transcribe, then add captions again.`,
      });
    }
    if (transcripts.size === 0) {
      return yield* new CaptionsError({
        reason: "no-clips",
        detail: "There is nothing to caption: no clip with sound is on the timeline.",
      });
    }
    const ops = captionTrackOps(snapshot.document, transcripts);
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

  return CaptionTrackService.of({ addCaptions });
});

export const layer = Layer.effect(CaptionTrackService, make);
