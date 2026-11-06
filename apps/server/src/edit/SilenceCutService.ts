// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Silence removal (S7V-027): reads a clip's cached transcript and its per-frame sound levels
// (`silence.detect`), plans keep ranges (`silencePlan.ts`) and writes them as one `setKeepRanges`
// through EditDocumentService, so the cut is one checkpoint and a repeat changes nothing.
import {
  type EditDocument,
  type EditMedia,
  type EditOp,
  type EngineError,
  type ProjectId,
  SilenceCutError,
  SilenceDetectResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as EngineService from "../engine/EngineService.ts";
import { projectFor, resolveMedia } from "../mcp/VideoProjectScope.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { DEFAULT_MIN_GAP_SECONDS, type FrameRange, planSilenceCuts } from "./silencePlan.ts";

export interface RemoveSilencesInput {
  readonly projectId: ProjectId;
  /** Media id or project path; the one placed (or imported) video when missing. */
  readonly media?: string;
  readonly minGapSeconds?: number;
  /** Clip-frame ranges (the transcript's frames) that must keep playing. */
  readonly keep?: ReadonlyArray<FrameRange>;
}

export interface RemoveSilencesResult {
  readonly media: string;
  readonly removedSeconds: number;
  readonly cuts: number;
  readonly keptSegments: number;
  readonly shortestSegmentFrames: number;
  readonly keptRequests: number;
  /** One plain sentence for the agent to pass on. */
  readonly message: string;
  readonly revision: number;
  /** False when the edit already had exactly these cuts, or there was nothing to cut. */
  readonly changed: boolean;
}

export class SilenceCutService extends Context.Service<
  SilenceCutService,
  {
    readonly removeSilences: (
      input: RemoveSilencesInput,
    ) => Effect.Effect<
      RemoveSilencesResult,
      SilenceCutError | EngineError | EditDocumentService.EditApplyError
    >;
  }
>()("t3/edit/SilenceCutService") {}

const refuse = (reason: SilenceCutError["reason"], detail: string) =>
  new SilenceCutError({ reason, detail });

const chooseMedia = Effect.fn("SilenceCutService.chooseMedia")(function* (
  document: EditDocument,
  requested: string | undefined,
) {
  if (requested !== undefined) {
    const entry = document.media.find(
      (media) => media.id === requested || media.path === requested,
    );
    if (entry === undefined) {
      return yield* refuse("media", `${requested} is not in this edit. Import it first.`);
    }
    return entry;
  }
  const placed = new Set(
    document.tracks.flatMap((track) =>
      track.kind === "video" ? track.items.map((item) => item.media) : [],
    ),
  );
  const candidates =
    placed.size > 0
      ? document.media.filter((media) => placed.has(media.id))
      : document.media.filter((media) => media.kind === "video");
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return only;
  return yield* refuse(
    "media",
    candidates.length === 0
      ? "This edit has no video clip yet. Import one first."
      : `Say which clip: ${candidates.map((media) => media.id).join(", ")}.`,
  );
});

/** The video track holding the clip, else the first video track, else a new one. */
function placement(document: EditDocument, media: EditMedia) {
  const videoTracks = document.tracks.flatMap((track) => (track.kind === "video" ? [track] : []));
  const holding = videoTracks.find((track) => track.items.some((item) => item.media === media.id));
  const track = holding ?? videoTracks[0];
  const own = track?.items.filter((item) => item.media === media.id) ?? [];
  const start =
    own.length > 0
      ? Math.min(...own.map((item) => item.start))
      : Math.max(0, ...(track?.items.map((item) => item.start + item.duration) ?? []));
  if (track !== undefined) return { trackId: track.id, start, addTrack: [] as EditOp[], own };
  const ids = new Set(document.tracks.map((entry) => entry.id));
  let index = 1;
  while (ids.has(`V${index}`)) index++;
  const trackId = `V${index}`;
  return {
    trackId,
    start,
    own,
    addTrack: [{ _tag: "addTrack", track: { kind: "video", id: trackId, items: [] } }] as EditOp[],
  };
}

/** Sound linked to the clip's video items would fall out of step, so it is refused for now. */
function hasLinkedAudio(document: EditDocument, media: EditMedia) {
  const links = new Set(
    document.tracks.flatMap((track) =>
      track.kind === "video"
        ? track.items.flatMap((item) =>
            item.media === media.id && item.linkId !== undefined ? [item.linkId] : [],
          )
        : [],
    ),
  );
  return document.tracks.some(
    (track) =>
      track.kind !== "video" &&
      track.items.some(
        (item) =>
          ("media" in item && item.media === media.id) ||
          ("linkId" in item && item.linkId !== undefined && links.has(item.linkId)),
      ),
  );
}

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const engine = yield* EngineService.EngineService;
  const transcripts = yield* TranscriptService.TranscriptService;
  const context = yield* Effect.context<
    | ProjectService.ProjectService
    | EditDocumentService.EditDocumentService
    | FileSystem.FileSystem
    | Path.Path
  >();

  const removeSilences = Effect.fn("SilenceCutService.removeSilences")(function* (
    input: RemoveSilencesInput,
  ) {
    const scopeFailure = (failure: { readonly message: string }) =>
      refuse("media", failure.message);
    const project = yield* projectFor(input.projectId).pipe(
      Effect.mapError(scopeFailure),
      Effect.provideContext(context),
    );
    const { document, revision } = project.snapshot;
    const media = yield* chooseMedia(document, input.media);
    const mediaFrames = media.probe.durationFrames;
    if (mediaFrames === undefined || !media.probe.hasAudio) {
      return yield* refuse("media", `${media.id} has no sound to find pauses in.`);
    }
    if (hasLinkedAudio(document, media)) {
      return yield* refuse(
        "linked-audio",
        `${media.id} has linked sound on another track; silence removal cannot cut it yet.`,
      );
    }
    const scoped = yield* resolveMedia(project, media.id).pipe(
      Effect.mapError(scopeFailure),
      Effect.provideContext(context),
    );
    const transcript = yield* transcripts
      .get({ projectId: input.projectId, media: media.id })
      .pipe(Effect.mapError((error) => refuse("no-transcript", error.message)));
    if (transcript === null) {
      return yield* refuse(
        "no-transcript",
        `${media.id} has no transcript yet. Run video_transcribe first.`,
      );
    }
    const detected = yield* engine.call(
      "silence.detect",
      { path: scoped.path },
      SilenceDetectResult,
    );
    const sameRate =
      detected.rate.num * transcript.fps.den === transcript.fps.num * detected.rate.den;
    if (!sameRate) {
      return yield* refuse(
        "no-transcript",
        `${media.id} changed since it was transcribed. Run video_transcribe again.`,
      );
    }

    const outside = (input.keep ?? []).find(
      (range) => range.fromFrame >= transcript.durationFrames,
    );
    if (outside !== undefined) {
      return yield* refuse(
        "keep",
        `keep ${outside.fromFrame}-${outside.toFrame} starts after the clip ends (${transcript.durationFrames} frames).`,
      );
    }
    const target = placement(document, media);
    const plan = planSilenceCuts({
      words: transcript.words,
      levels: detected.levels,
      sourceRate: transcript.fps,
      sourceFrames: transcript.durationFrames,
      documentRate: document.fps,
      mediaFrames,
      minGapSeconds: input.minGapSeconds ?? DEFAULT_MIN_GAP_SECONDS,
      keep: input.keep ?? [],
      ...(target.own.length === 0
        ? {}
        : { current: target.own.map((item) => ({ in: item.in, duration: item.duration })) }),
    });
    if (plan._tag === "no-speech") {
      return yield* refuse(
        "no-speech",
        `${media.id} has no speech in its transcript, so removing its silences would remove everything.`,
      );
    }

    const seconds = (frames: number) =>
      Math.round(((frames * document.fps.den) / document.fps.num) * 10) / 10;
    const summary = {
      media: media.id,
      removedSeconds: seconds(plan.removedFrames),
      cuts: plan.cuts,
      keptSegments: plan.ranges.length,
      shortestSegmentFrames: plan.shortestFrames,
      keptRequests: plan.keptRequests,
      message: [
        plan.cuts === 0
          ? "No more pauses to cut; the edit is unchanged."
          : `Removed ${seconds(plan.removedFrames)} s in ${plan.cuts} cuts${plan.keptRequests > 0 ? `, keeping ${plan.keptRequests} pause(s) as asked` : ""}. This only cuts more; it never restores earlier cuts.`,
        ...alreadyCutSentence(plan.alreadyCut),
      ].join(" "),
    };
    // Nothing new to remove: the edit stays exactly as it is.
    if (plan.cuts === 0) return { ...summary, revision, changed: false };
    const after = yield* edits.apply(
      input.projectId,
      [
        ...target.addTrack,
        {
          _tag: "setKeepRanges",
          trackId: target.trackId,
          mediaId: media.id,
          ranges: plan.ranges,
          start: target.start,
        },
      ],
      { origin: "agent", baseRevision: revision },
    );
    return { ...summary, revision: after.revision, changed: after.revision !== revision };
  });

  return SilenceCutService.of({ removeSilences });
});

/** One sentence naming requested keeps that lie in an earlier cut, or none. */
function alreadyCutSentence(ranges: ReadonlyArray<FrameRange>): string[] {
  if (ranges.length === 0) return [];
  const names = ranges.map((range) => `${range.fromFrame}-${range.toFrame}`);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return ranges.length === 1
    ? [
        `The pause you asked to keep at ${list} was already cut, so it stays cut; say undo to bring it back.`,
      ]
    : [
        `The pauses you asked to keep at ${list} were already cut, so they stay cut; say undo to bring them back.`,
      ];
}

export const layer = Layer.effect(SilenceCutService, make);
