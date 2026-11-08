// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Silence removal (S7V-027): reads a clip's cached transcript and its per-frame sound levels,
// plans keep ranges (`silencePlan.ts`) and writes them as one `setKeepRanges` through
// EditDocumentService, so the cut is one checkpoint and a repeat changes nothing. The levels come
// from the file the transcribe job writes beside the transcript; when it is missing, a `silence`
// engine job measures them once and writes it (S7V-055).
import {
  type EditDocument,
  type EditMedia,
  type EditOp,
  type EngineError,
  type EngineJobId,
  type ProjectId,
  SilenceCutError,
  SilenceDetectResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as EngineService from "../engine/EngineService.ts";
import { projectFor, resolveMedia } from "../mcp/VideoProjectScope.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TranscriptService from "../transcript/TranscriptService.ts";
import { canvasForClip } from "./canvasForClip.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { DEFAULT_MIN_GAP_SECONDS, type FrameRange, planSilenceCuts } from "./silencePlan.ts";

export interface RemoveSilencesInput {
  readonly projectId: ProjectId;
  /** Media id or project path; the one placed (or imported) video when missing. */
  readonly media?: string;
  readonly minGapSeconds?: number;
  /** Clip-frame ranges (the transcript's frames) that must keep playing. */
  readonly keep?: ReadonlyArray<FrameRange>;
  /** The chat reply asking, so its changes make one version (S7V-069). */
  readonly reply?: EditDocumentService.EditReply | undefined;
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

/**
 * How long one call waits for a `silence` job before handing its id back: under Codex's 60 s tool
 * limit. A 30-minute clip measures in about 1 s on an M-series Mac (S7V-055).
 */
const MEASURE_WAIT = "20 seconds";

/** A running `silence` job: its id once the engine has it, and its outcome. */
interface Measuring {
  readonly started: Deferred.Deferred<EngineJobId, EngineError>;
  readonly result: Deferred.Deferred<SilenceDetectResult, EngineError>;
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
  const serviceScope = yield* Effect.scope;
  // One `silence` job per clip at a time: a call made while it runs waits on the same job.
  const measuring = new Map<string, Measuring>();
  const context = yield* Effect.context<
    | ProjectService.ProjectService
    | EditDocumentService.EditDocumentService
    | FileSystem.FileSystem
    | Path.Path
  >();

  /** Measures the clip's levels as a job (it writes the levels file); waits `MEASURE_WAIT` for it. */
  const measure = Effect.fnUntraced(function* (
    mediaId: string,
    source: TranscriptService.TranscriptLevels["measure"],
  ) {
    const key = `${source.cacheDir}\0${source.fingerprint.sha256}`;
    let entry = measuring.get(key);
    if (entry === undefined) {
      // In the map before the job has its id, so a call arriving meanwhile joins this one.
      const own: Measuring = { started: Deferred.makeUnsafe(), result: Deferred.makeUnsafe() };
      entry = own;
      const job = engine
        .runJob({
          kind: "silence",
          method: "silence.detect",
          params: { path: source.path, cacheDir: source.cacheDir, fingerprint: source.fingerprint },
          success: SilenceDetectResult,
          projectId: source.projectId,
          onStart: (id) => Deferred.succeed(own.started, id).pipe(Effect.asVoid),
        })
        .pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (measuring.get(key) === own) measuring.delete(key);
              return Deferred.done(own.result, exit).pipe(
                Effect.andThen(
                  Exit.isFailure(exit) ? Deferred.failCause(own.started, exit.cause) : Effect.void,
                ),
              );
            }),
          ),
          // The job itself stays interruptible (the service's scope ends it on shutdown).
          Effect.interruptible,
        );
      // Set and fork as one step: a caller cut off between them would leave an entry with no
      // job, and every later call for the clip would wait on it forever. In the service's scope,
      // so the job keeps going when this call stops waiting or is cut off.
      yield* Effect.uninterruptible(
        Effect.suspend(() => {
          measuring.set(key, own);
          return Effect.forkIn(job, serviceScope);
        }),
      );
    }
    const done = yield* Deferred.await(entry.result).pipe(Effect.timeoutOption(MEASURE_WAIT));
    if (done._tag === "Some") return done.value;
    const jobId = yield* Deferred.await(entry.started);
    return yield* refuse(
      "measuring",
      `Measuring the sound of ${mediaId} first (video job ${jobId}). Wait for it with video_job_status, then call video_remove_silences again.`,
    );
  });

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
    yield* resolveMedia(project, media.id).pipe(
      Effect.mapError(scopeFailure),
      Effect.provideContext(context),
    );
    const found = yield* transcripts
      .levels({ projectId: input.projectId, media: media.id })
      .pipe(Effect.mapError((error) => refuse("no-transcript", error.message)));
    const { transcript } = found;
    if (transcript === null) {
      return yield* refuse(
        "no-transcript",
        `${media.id} has no transcript yet. Run video_transcribe first.`,
      );
    }
    // The cached file was already checked against the transcript (file, rate and frame count).
    const detected = found.cached ?? (yield* measure(media.id, found.measure));
    const detectedRate = "fps" in detected ? detected.fps : detected.rate;
    const sameClock =
      detectedRate.num * transcript.fps.den === transcript.fps.num * detectedRate.den &&
      detected.durationFrames === transcript.durationFrames;
    if (!sameClock) {
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
    // The first clip on an empty timeline gives the edit its shape, in the same checkpoint, unless
    // the user already chose one (S7V-061).
    const empty = document.tracks.every(
      (track) => track.kind !== "video" || track.items.length === 0,
    );
    const chosen = document.metadata.canvasChosen === true;
    const canvas = empty && !chosen ? canvasForClip(media.probe) : undefined;
    const reshape =
      canvas === undefined ||
      (canvas.width === document.canvas.width && canvas.height === document.canvas.height)
        ? []
        : [{ _tag: "setCanvas", canvas, fromClip: true } as const];
    const after = yield* edits.apply(
      input.projectId,
      [
        ...target.addTrack,
        ...reshape,
        {
          _tag: "setKeepRanges",
          trackId: target.trackId,
          mediaId: media.id,
          ranges: plan.ranges,
          start: target.start,
        },
      ],
      {
        origin: "agent",
        baseRevision: revision,
        reply: input.reply,
        summary: `Removed ${summary.removedSeconds} s of silence in ${plan.cuts} cuts`,
      },
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
  // One undo may only take back this call's cuts, so the hint never promises that.
  return ranges.length === 1
    ? [
        `The pause you asked to keep at clip frames ${list} was cut by an earlier edit, so it stays cut. To get it back, undo until that pause plays again, then ask to keep it.`,
      ]
    : [
        `The pauses you asked to keep at clip frames ${list} were cut by an earlier edit, so they stay cut. To get them back, undo until those pauses play again, then ask to keep them.`,
      ];
}

export const layer = Layer.effect(SilenceCutService, make);
