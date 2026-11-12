// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Sound effects and music placed by the agent (S7V-036), each call one change and one undo step.
 * Levels against the voice become the item's own gain from measured loudness (`.s7cache/loudness`).
 * Duck ranges stay on their frames, so the skill ducks again after a later cut (S7V-090).
 */
import {
  type EditDocument,
  type EditMedia,
  type EngineError,
  EditUnavailableError,
  MediaLoudnessResult,
  type MediaLoudnessInput,
  type ProjectId,
  SoundError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as EngineService from "../engine/EngineService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { mediaFingerprint } from "../transcript/mediaFingerprint.ts";
import {
  DUCK_DEPTH_DB,
  SILENT_VOICE_LUFS,
  defaultLevelDb,
  isAudible,
  itemGainDb,
} from "./audioLevels.ts";
import { duckOps, duckOver, placementOps, videoEndFrame } from "./audioPlacement.ts";
import { loadCaptionTranscripts } from "./captionTrack.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { snapToWord, speechRanges, timecode, timelineFrameOf } from "./timelineMap.ts";
import { ASSEMBLE_FIRST } from "./videoTrack.ts";

const LOUDNESS_VERSION = 1;
const LEVEL_RANGE_DB = { min: -60, max: 20 } as const;
const DEPTH_RANGE_DB = { min: -40, max: -1 } as const;

const LoudnessCacheFile = Schema.Struct({
  loudnessVersion: Schema.Literal(LOUDNESS_VERSION),
  sha256: Schema.String,
  size: Schema.Int,
  integratedLufs: Schema.NullOr(Schema.Finite),
});
const decodeCache = Schema.decodeUnknownOption(Schema.fromJsonString(LoudnessCacheFile));
const encodeCache = Schema.encodeSync(Schema.fromJsonString(LoudnessCacheFile));

export interface PlaceAudioInput {
  readonly media: string;
  /** A frame of `clip` at its transcript's rate, snapped to the start of the word it falls in. */
  readonly at?: number | undefined;
  readonly clip?: string | undefined;
  readonly track?: "sfx" | "music" | undefined;
  /** The level relative to the voice; the track's preset when missing. */
  readonly gainDb?: number | undefined;
}

export interface PlaceAudioResult {
  readonly revision: number;
  readonly item: {
    readonly id: string;
    readonly trackId: string;
    readonly start: number;
    readonly duration: number;
    readonly gainDb: number;
  };
  readonly message: string;
}

export interface DuckMusicResult {
  readonly revision: number;
  readonly ranges: number;
  readonly changed: boolean;
  readonly message: string;
}

export class AudioTrackService extends Context.Service<
  AudioTrackService,
  {
    readonly placeAudio: (
      projectId: ProjectId,
      input: PlaceAudioInput,
      options: EditDocumentService.EditCaller,
    ) => Effect.Effect<
      PlaceAudioResult,
      SoundError | EngineError | EditDocumentService.EditApplyError
    >;
    readonly duckMusic: (
      projectId: ProjectId,
      input: { readonly depthDb?: number | undefined },
      options: EditDocumentService.EditCaller,
    ) => Effect.Effect<DuckMusicResult, SoundError | EditDocumentService.EditApplyError>;
  }
>()("t3/edit/AudioTrackService") {}

const refuse = (reason: SoundError["reason"], detail: string) => new SoundError({ reason, detail });

const nameOf = (media: EditMedia) => media.label ?? media.path ?? media.id;

const findMedia = (document: EditDocument, media: string) =>
  document.media.find((entry) => entry.id === media || entry.path === media);

const make = Effect.gen(function* () {
  const edits = yield* EditDocumentService.EditDocumentService;
  const projects = yield* ProjectService.ProjectService;
  const engine = yield* EngineService.EngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const projectRoot = Effect.fn("AudioTrackService.projectRoot")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(project)) {
      return yield* new EditUnavailableError({
        projectId,
        reason: "unknown-project",
        explanation: "This project no longer exists.",
      });
    }
    return path.resolve(project.value.workspaceRoot);
  });

  const locate = (root: string, media: EditMedia) =>
    media.path !== undefined ? path.resolve(root, media.path) : path.resolve(media.reference ?? "");

  /** The file's integrated LUFS, or null for silence; from the cache when it is this exact file. */
  const loudnessOf = Effect.fn("AudioTrackService.loudnessOf")(function* (
    root: string,
    media: EditMedia,
  ) {
    const file = locate(root, media);
    const fingerprint = yield* mediaFingerprint(file).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError(() =>
        refuse("unknown-media", `${nameOf(media)} can't be read. Import it again.`),
      ),
    );
    const cacheDir = path.join(root, ".s7cache", "loudness");
    const cacheFile = path.join(cacheDir, `${fingerprint.sha256}.json`);
    const cached = yield* fileSystem.readFileString(cacheFile).pipe(
      Effect.map((text) => Option.getOrUndefined(decodeCache(text))),
      Effect.orElseSucceed(() => undefined),
    );
    if (cached !== undefined && cached.size === fingerprint.size) return cached.integratedLufs;
    const params: MediaLoudnessInput = { path: file };
    const { integratedLufs } = yield* engine.call("media.loudness", params, MediaLoudnessResult);
    const entry = {
      loudnessVersion: LOUDNESS_VERSION as typeof LOUDNESS_VERSION,
      sha256: fingerprint.sha256,
      size: fingerprint.size,
      integratedLufs,
    };
    // A cache file that can't be written, or is cut short, only costs a measurement next time.
    yield* fileSystem
      .makeDirectory(cacheDir, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(cacheFile, encodeCache(entry))),
        Effect.ignore,
      );
    return integratedLufs;
  });

  const placeAudio: AudioTrackService["Service"]["placeAudio"] = Effect.fn(
    "AudioTrackService.placeAudio",
  )(function* (projectId, input, options) {
    const snapshot = yield* edits.read(projectId);
    const { document } = snapshot;
    const asset = findMedia(document, input.media);
    if (asset === undefined) {
      return yield* refuse(
        "unknown-media",
        `${input.media} is not in this edit's media. Import it first with video_import.`,
      );
    }
    if (asset.kind === "image" || !asset.probe.hasAudio) {
      return yield* refuse(
        "no-sound",
        `${nameOf(asset)} has no sound, so it can't be a sound effect or music.`,
      );
    }
    const end = videoEndFrame(document);
    const items = document.tracks.find((track) => track.kind === "video")?.items ?? [];
    const clips = [...new Set([...items].sort((a, b) => a.start - b.start).map((i) => i.media))];
    if (end === 0 || clips.length === 0) {
      return yield* refuse("no-video", `The timeline has no video yet. ${ASSEMBLE_FIRST}`);
    }
    const levelDb = input.gainDb ?? defaultLevelDb(input.track ?? "sfx");
    if (levelDb < LEVEL_RANGE_DB.min || levelDb > LEVEL_RANGE_DB.max) {
      return yield* refuse(
        "out-of-range",
        `gainDb is the level against the voice in dB, from ${LEVEL_RANGE_DB.min} to ${LEVEL_RANGE_DB.max}.`,
      );
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
    } else if (input.at !== undefined && clips.length > 1) {
      return yield* refuse(
        "which-clip",
        `This edit has several clips (${clips.join(", ")}). Say which clip at is a frame of, with clip.`,
      );
    }
    const root = yield* projectRoot(projectId);
    let start = 0;
    let onWord = "";
    if (input.at !== undefined) {
      if (input.at < 0) return yield* refuse("out-of-range", "at is a clip frame, from 0.");
      const clipMedia = document.media.find((entry) => entry.id === clip)!;
      const { transcripts } = yield* loadCaptionTranscripts(root, document).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const rate = transcripts.get(clip)?.fps ?? clipMedia.probe.fps ?? document.fps;
      const mapped = timelineFrameOf(document, clip, input.at, rate);
      if (mapped === null) {
        return yield* refuse(
          "cut",
          `Frame ${input.at} of ${clip} was cut from the edit, so nothing was added. Pick a moment that is still in it (video_transcript_read).`,
        );
      }
      const transcript = transcripts.get(clip);
      const snapped =
        transcript === undefined ? null : snapToWord(document, clip, transcript, mapped);
      start = snapped?.frame ?? mapped;
      onWord =
        transcript === undefined
          ? " (not snapped to a word: the clip has no transcript)"
          : snapped === null
            ? " (after the last word, so not snapped)"
            : `, on "${snapped.word}"`;
    }
    const mediaFrames = asset.probe.durationFrames ?? 0;
    if (mediaFrames < 1) {
      return yield* refuse("no-sound", `${nameOf(asset)} has no length. Import it again.`);
    }
    // A clip with no sound (B-roll, a screen recording) or only room noise levels against −14.
    const voice = document.media.find((entry) => entry.id === clip)!;
    const measuredVoice = voice.probe.hasAudio ? yield* loudnessOf(root, voice) : null;
    const voiceLufs = isAudible(measuredVoice) ? measuredVoice : SILENT_VOICE_LUFS;
    const assetLufs = yield* loudnessOf(root, asset);
    if (!isAudible(assetLufs)) {
      return yield* refuse(
        "no-sound",
        `${nameOf(asset)} is silent or nearly silent, so there is nothing to hear.`,
      );
    }
    const track = input.track ?? "sfx";
    const placement = placementOps(document, {
      media: asset.id,
      track,
      start,
      mediaFrames,
      gainDb: itemGainDb(voiceLufs, assetLufs, levelDb),
    });
    const what = track === "sfx" ? "sound effect" : "music";
    const after = yield* edits.apply(projectId, placement.ops, {
      origin: "agent",
      baseRevision: snapshot.revision,
      reply: options.reply,
      summary: `Added ${what} "${nameOf(asset)}"`,
    });
    const level =
      levelDb === 0
        ? "as loud as the voice"
        : `${Math.abs(levelDb)} dB ${levelDb < 0 ? "under" : "over"} the voice`;
    const where =
      track === "music"
        ? `from ${timecode(start, document.fps)}${onWord} to ${timecode(start + placement.item.duration, document.fps)}`
        : `at ${timecode(start, document.fps)}${onWord}`;
    return {
      revision: after.revision,
      item: placement.item,
      message: `Added "${nameOf(asset)}" on the ${what} track ${where}, ${level}.`,
    };
  });

  const duckMusic: AudioTrackService["Service"]["duckMusic"] = Effect.fn(
    "AudioTrackService.duckMusic",
  )(function* (projectId, input, options) {
    const depthDb = input.depthDb ?? DUCK_DEPTH_DB;
    if (depthDb < DEPTH_RANGE_DB.min || depthDb > DEPTH_RANGE_DB.max) {
      return yield* refuse(
        "out-of-range",
        `depthDb is how far the music dips, in dB from ${DEPTH_RANGE_DB.min} to ${DEPTH_RANGE_DB.max}.`,
      );
    }
    const snapshot = yield* edits.read(projectId);
    const { document } = snapshot;
    const music = document.tracks.filter(
      (track) => track.kind === "music" && track.items.length > 0,
    );
    if (music.length === 0) {
      return yield* refuse(
        "no-music",
        "There is no music in the edit yet. Place it with video_place_audio first.",
      );
    }
    if (music.every((track) => track.locked === true)) {
      return yield* refuse(
        "locked",
        "The music track is locked. Ask the user to unlock it on the timeline, then dip the music again.",
      );
    }
    const root = yield* projectRoot(projectId);
    const { transcripts, missing } = yield* loadCaptionTranscripts(root, document).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (missing.length > 0) {
      return yield* refuse(
        "no-transcript",
        `Transcribe the clip first: ${missing.join(", ")} has no transcript. Run video_transcribe, then duck the music again.`,
      );
    }
    const ranges = speechRanges(document, transcripts);
    if (ranges.length === 0) {
      return yield* refuse(
        "no-transcript",
        "There is no speech on the timeline to dip the music under.",
      );
    }
    const duck = duckOver(document, ranges, depthDb);
    const ops = duckOps(document, duck);
    const dips = `${Math.abs(depthDb)} dB under speech in ${ranges.length} place${ranges.length === 1 ? "" : "s"}`;
    if (ops.length === 0) {
      return {
        revision: snapshot.revision,
        ranges: ranges.length,
        changed: false,
        message: `The music already dips ${dips}.`,
      };
    }
    const after = yield* edits.apply(projectId, ops, {
      origin: "agent",
      baseRevision: snapshot.revision,
      reply: options.reply,
      summary: "Dipped the music under speech",
    });
    return {
      revision: after.revision,
      ranges: ranges.length,
      changed: true,
      message: `The music now dips ${dips}. After any later cut, run video_duck_music again.`,
    };
  });

  return AudioTrackService.of({ placeAudio, duckMusic });
});

export const layer = Layer.effect(AudioTrackService, make);
