// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Punch-in zooms the agent adds (S7V-037), each call one change and one undo step. The range is
 * clip frames, mapped through the edit as sound placement maps `at` (S7V-036), so a zoom lands on
 * the frames the transcript names. The export draws it; the player doesn't yet (S7V-092).
 */
import {
  type EditDocument,
  EditUnavailableError,
  type ProjectId,
  ZoomError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import { loadCaptionTranscripts } from "./captionTrack.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { timecode, timelineRangesOf } from "./timelineMap.ts";
import { DEFAULT_ZOOM, ZOOM_SCALE, zoomOps } from "./zoomOps.ts";

export interface ZoomInput {
  /** Clip frames of `clip` at its transcript's rate, end exclusive. */
  readonly from: number;
  readonly to: number;
  readonly clip?: string | undefined;
  readonly scale?: number | undefined;
  /** The point that stays put while the picture grows, as a share of the frame (0 left/top). */
  readonly anchorX?: number | undefined;
  readonly anchorY?: number | undefined;
}

export interface ZoomResult {
  readonly revision: number;
  readonly items: number;
  readonly message: string;
}

export class ZoomService extends Context.Service<
  ZoomService,
  {
    readonly zoom: (
      projectId: ProjectId,
      input: ZoomInput,
      options: EditDocumentService.EditCaller,
    ) => Effect.Effect<ZoomResult, ZoomError | EditDocumentService.EditApplyError>;
  }
>()("t3/edit/ZoomService") {}

const refuse = (reason: ZoomError["reason"], detail: string) => new ZoomError({ reason, detail });

const findMedia = (document: EditDocument, media: string) =>
  document.media.find((entry) => entry.id === media || entry.path === media);

const unit = (value: number) => value >= 0 && value <= 1;

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const zoom: ZoomService["Service"]["zoom"] = Effect.fn("ZoomService.zoom")(
    function* (projectId, input, options) {
      const scale = input.scale ?? DEFAULT_ZOOM.scale;
      if (!(scale >= ZOOM_SCALE.min && scale <= ZOOM_SCALE.max)) {
        return yield* refuse(
          "out-of-range",
          "scale is how far to zoom in, from 1.0 (not at all) to 2.0 (twice as close).",
        );
      }
      const anchorX = input.anchorX ?? DEFAULT_ZOOM.anchorX;
      if (!unit(anchorX)) {
        return yield* refuse(
          "out-of-range",
          "anchorX is the point across the frame that stays put, from 0 (left) to 1 (right).",
        );
      }
      const anchorY = input.anchorY ?? DEFAULT_ZOOM.anchorY;
      if (!unit(anchorY)) {
        return yield* refuse(
          "out-of-range",
          "anchorY is the point down the frame that stays put, from 0 (top) to 1 (bottom).",
        );
      }
      const snapshot = yield* edits.read(projectId);
      const { document } = snapshot;
      const items = document.tracks.find((track) => track.kind === "video")?.items ?? [];
      const clips = [...new Set([...items].sort((a, b) => a.start - b.start).map((i) => i.media))];
      if (clips.length === 0) {
        return yield* refuse("no-video", "The timeline has no video yet. Add a clip first.");
      }
      let clip = clips[0]!;
      if (input.clip !== undefined) {
        const named = findMedia(document, input.clip);
        if (named === undefined || !clips.includes(named.id)) {
          return yield* refuse(
            "which-clip",
            `${input.clip} is not on the timeline. clip is one of: ${clips.join(", ")}.`,
          );
        }
        clip = named.id;
      } else if (clips.length > 1) {
        return yield* refuse(
          "which-clip",
          `This edit has several clips (${clips.join(", ")}). Say which clip the range is in, with clip.`,
        );
      }
      const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(project)) {
        return yield* new EditUnavailableError({
          projectId,
          reason: "unknown-project",
          explanation: "This project no longer exists.",
        });
      }
      const { transcripts } = yield* loadCaptionTranscripts(
        path.resolve(project.value.workspaceRoot),
        document,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const clipMedia = document.media.find((entry) => entry.id === clip)!;
      const rate = transcripts.get(clip)?.fps ?? clipMedia.probe.fps ?? document.fps;
      const ranges = timelineRangesOf(document, clip, input.from, input.to, rate);
      if (ranges.length === 0) {
        return yield* refuse(
          "cut",
          "That moment was cut from the edit, so nothing was zoomed. Pick one that is still in it (video_transcript_read).",
        );
      }
      const planned = zoomOps(document, ranges, { scale, anchorX, anchorY, rampFrames: 0 });
      const from = timecode(ranges[0]!.start, document.fps);
      const after = yield* edits.apply(projectId, planned.ops, {
        origin: "agent",
        baseRevision: snapshot.revision,
        reply: options.reply,
        summary: `Zoomed in at ${from}`,
      });
      const to = timecode(ranges.at(-1)!.end, document.fps);
      return {
        revision: after.revision,
        items: planned.items,
        message: `Zoomed in ${scale}x from ${from} to ${to}. It shows in the exported video, not in the player.`,
      };
    },
  );

  return ZoomService.of({ zoom });
});

export const layer = Layer.effect(ZoomService, make);
