// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Writes the clips, their transcripts and the loudness cache.
/**
 * S7V-036: placing sound effects and music, and ducking, on the real edit and history services.
 * The engine is faked: `media.loudness` answers from a table and counts its calls.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type EditOp,
  type ProjectId,
  RunId,
  SoundError,
  ThreadId,
  validateEditDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EngineService from "../engine/EngineService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as AudioTrackService from "./AudioTrackService.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { layerEditTest } from "./editHarness.testkit.ts";

const FPS = { num: 30, den: 1 };
const reply = { threadId: ThreadId.make("thread-sound"), runId: RunId.make("run-sound") };

/** Integrated LUFS by file name; null is silence. */
const LOUDNESS: Record<string, number | null> = {
  "cam.mp4": -20,
  "second.mp4": -16,
  "quiet.mp4": null,
  "whoosh.wav": -10,
  "bed.wav": -30,
  "hush.wav": null,
};

const bytesOf = (name: string) => Buffer.from(`synthetic ${name}`);
const fingerprintOf = (bytes: Buffer) => ({
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
});

const video = (id: string, file = `${id}.mp4`) => ({
  id,
  kind: "video" as const,
  path: `assets/${file}`,
  fingerprint: fingerprintOf(bytesOf(file)),
  probe: { durationFrames: 900, hasVideo: true, hasAudio: true, fps: FPS },
});

const audio = (id: string, durationFrames: number, hasAudio = true) => ({
  id,
  kind: "audio" as const,
  path: `assets/${id}.wav`,
  label: id,
  fingerprint: fingerprintOf(bytesOf(`${id}.wav`)),
  probe: { durationFrames, hasVideo: false, hasAudio },
});

const writeFiles = (root: string) => {
  NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
  for (const name of Object.keys(LOUDNESS)) {
    NodeFS.writeFileSync(NodePath.join(root, "assets", name), bytesOf(name));
  }
};

/** The clip `cam`'s cached transcript: words in clip frames at 30 fps. */
const writeTranscript = (root: string, words: ReadonlyArray<readonly [number, number]>) => {
  const fingerprint = fingerprintOf(bytesOf("cam.mp4"));
  const dir = NodePath.join(root, ".s7cache", "transcripts");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, `${fingerprint.sha256}.json`),
    JSON.stringify({
      transcriptVersion: 1,
      mediaFingerprint: fingerprint,
      model: "test",
      revision: "test",
      fps: FPS,
      durationFrames: 900,
      words: words.map(([startFrame, endFrame], index) => ({
        text: `w${index}`,
        startFrame,
        endFrame,
        confidence: 1,
        speaker: "S1",
      })),
      createdAt: "2026-11-12T00:00:00.000Z",
    }),
  );
};

interface Project {
  readonly projectId: ProjectId;
  readonly root: string;
  readonly edits: EditDocumentService.EditDocumentService["Service"];
  readonly sounds: AudioTrackService.AudioTrackService["Service"];
  readonly measured: string[];
}

const withProject = <A, E>(body: (project: Project) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-sound-" });
    const measured: string[] = [];
    const engine = Layer.mock(EngineService.EngineService)({
      subscribeJobs: Stream.make({ type: "snapshot" as const, jobs: [] }),
      call: (method, params, success) => {
        if (method !== "media.loudness") return Effect.die(`unexpected engine call ${method}`);
        const name = NodePath.basename(String(params["path"]));
        measured.push(name);
        return Schema.decodeEffect(success)({ integratedLufs: LOUDNESS[name] }).pipe(Effect.orDie);
      },
    });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const created = yield* folders.createNamedProject({ name: "Sound test" });
      writeFiles(created.workspaceRoot);
      return yield* body({
        projectId: created.projectId,
        root: created.workspaceRoot,
        edits: yield* EditDocumentService.EditDocumentService,
        sounds: yield* AudioTrackService.AudioTrackService,
        measured,
      });
    }).pipe(
      Effect.provide(
        AudioTrackService.layer.pipe(
          Layer.provideMerge(engine),
          Layer.provideMerge(layerEditTest(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** `cam` cut to frames 0-30, 50-80 and 100-130, with the sounds in Assets. */
const cutEdit = (extra: EditOp[] = []): EditOp[] => [
  { _tag: "putMedia", media: video("cam") },
  { _tag: "putMedia", media: audio("whoosh", 15) },
  { _tag: "putMedia", media: audio("bed", 900) },
  { _tag: "putMedia", media: audio("hush", 30) },
  { _tag: "putMedia", media: audio("mute", 30, false) },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
  {
    _tag: "setKeepRanges",
    trackId: "V1",
    mediaId: "cam",
    ranges: [
      { in: 0, duration: 30 },
      { in: 50, duration: 30 },
      { in: 100, duration: 30 },
    ],
  },
  ...extra,
];

const setUp = (project: Project, ops: EditOp[] = cutEdit()) =>
  Effect.gen(function* () {
    const initial = yield* project.edits.read(project.projectId);
    return yield* project.edits.apply(project.projectId, ops, {
      origin: "agent",
      baseRevision: initial.revision,
    });
  });

const editJson = (root: string) => NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8");

describe("AudioTrackService.placeAudio", () => {
  it.effect("places a sound effect on a word's clip frame, mapped through the cut", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project);
        // Clip frame 60 plays at timeline frame 40 (the second kept part starts at 50).
        const placed = yield* project.sounds.placeAudio(
          project.projectId,
          { media: "whoosh", at: 60 },
          { reply },
        );
        expect(placed.item).toEqual({
          id: "sfx1",
          trackId: "S1",
          start: 40,
          duration: 15,
          gainDb: -19,
        });
        expect(placed.message).toBe(
          'Added "whoosh" on the sound effect track at 1.3 s, 9 dB under the voice.',
        );
        const after = yield* project.edits.read(project.projectId);
        expect(validateEditDocument(after.document).ok).toBe(true);
        const [newest] = yield* project.edits.versions(project.projectId);
        expect(newest!.changes).toEqual(['Added sound effect "whoosh"']);
      }),
    ),
  );

  it.effect("refuses in plain words and writes nothing", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project);
        const before = editJson(project.root);
        const cases: ReadonlyArray<readonly [AudioTrackService.PlaceAudioInput, string]> = [
          [
            { media: "nope" },
            "nope is not in this edit's media. Import it first with video_import.",
          ],
          [{ media: "mute" }, "mute has no sound, so it can't be a sound effect or music."],
          [{ media: "hush" }, "hush is silent, so there is nothing to hear."],
          [
            { media: "whoosh", at: 40 },
            "Frame 40 of cam was cut from the edit, so nothing was added. Pick a moment that is still in it (video_transcript_read).",
          ],
          [{ media: "whoosh", at: -1 }, "at is a clip frame, from 0."],
          [{ media: "whoosh", clip: "bed" }, "bed is not on the timeline. clip is one of: cam."],
          [
            { media: "whoosh", gainDb: 30 },
            "gainDb is the level against the voice in dB, from -60 to 20.",
          ],
        ];
        for (const [input, detail] of cases) {
          const error = yield* project.sounds
            .placeAudio(project.projectId, input, { reply })
            .pipe(Effect.flip);
          assert(error._tag === "SoundError", JSON.stringify(input));
          expect(error.detail, JSON.stringify(input)).toBe(detail);
        }
        expect(editJson(project.root)).toBe(before);
      }),
    ),
  );

  it.effect("refuses when there is no video on the timeline yet", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project, [{ _tag: "putMedia", media: audio("whoosh", 15) }]);
        const error = yield* project.sounds
          .placeAudio(project.projectId, { media: "whoosh" }, { reply })
          .pipe(Effect.flip);
        expect(error).toEqual(
          new SoundError({
            reason: "no-video",
            detail: "The timeline has no video yet. Add a clip first.",
          }),
        );
      }),
    ),
  );

  it.effect("with several clips, at needs clip; the named clip is mapped and measured", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project, [
          ...cutEdit(),
          { _tag: "putMedia", media: video("second") },
          {
            _tag: "insertItem",
            trackId: "V1",
            item: { id: "v-second", media: "second", start: 90, duration: 60, in: 200 },
          },
        ]);
        const refused = yield* project.sounds
          .placeAudio(project.projectId, { media: "whoosh", at: 210 }, { reply })
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "This edit has several clips (cam, second). Say which clip at is a frame of, with clip.",
        );
        const placed = yield* project.sounds.placeAudio(
          project.projectId,
          { media: "whoosh", at: 210, clip: "second" },
          { reply },
        );
        // Frame 210 of "second" is 10 frames into its item at 90; levels against its -16 LUFS.
        expect(placed.item).toMatchObject({ start: 100, gainDb: -15 });
        // No at: the edit's start, against the first clip on the timeline.
        const music = yield* project.sounds.placeAudio(
          project.projectId,
          { media: "bed", track: "music" },
          { reply },
        );
        expect(music.item).toMatchObject({ start: 0, duration: 150, gainDb: -8 });
      }),
    ),
  );

  it.effect("measures each file once, then reads the loudness cache", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project);
        yield* project.sounds.placeAudio(project.projectId, { media: "whoosh" }, { reply });
        yield* project.sounds.placeAudio(
          project.projectId,
          { media: "assets/whoosh.wav", at: 100 },
          { reply },
        );
        expect(project.measured.toSorted()).toEqual(["cam.mp4", "whoosh.wav"]);
        const cached = NodeFS.readdirSync(NodePath.join(project.root, ".s7cache", "loudness"));
        expect(cached.toSorted()).toEqual(
          [
            `${fingerprintOf(bytesOf("cam.mp4")).sha256}.json`,
            `${fingerprintOf(bytesOf("whoosh.wav")).sha256}.json`,
          ].toSorted(),
        );
        // The second sound overlaps nothing, so both share the first track.
        const after = yield* project.edits.read(project.projectId);
        const sfx = after.document.tracks.filter((track) => track.kind === "sfx");
        expect(sfx.map((track) => track.items.length)).toEqual([2]);
      }),
    ),
  );

  it.effect("levels against the export's target when the voice clip is silent", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project, [
          { _tag: "putMedia", media: video("cam", "quiet.mp4") },
          { _tag: "putMedia", media: audio("whoosh", 15) },
          { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
          {
            _tag: "insertItem",
            trackId: "V1",
            item: { id: "v0", media: "cam", start: 0, duration: 90, in: 0 },
          },
        ]);
        const placed = yield* project.sounds.placeAudio(
          project.projectId,
          { media: "whoosh" },
          { reply },
        );
        // -14 - 9 - (-10)
        expect(placed.item.gainDb).toBe(-13);
      }),
    ),
  );
});

describe("AudioTrackService.duckMusic", () => {
  it.effect("ducks every speech range, merged across short gaps", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project);
        writeTranscript(project.root, [
          [5, 12],
          [15, 28],
          [55, 70],
          [110, 125],
        ]);
        yield* project.sounds.placeAudio(
          project.projectId,
          { media: "bed", track: "music" },
          { reply },
        );
        const ducked = yield* project.sounds.duckMusic(project.projectId, {}, { reply });
        expect(ducked).toMatchObject({ ranges: 2, changed: true });
        const after = yield* project.edits.read(project.projectId);
        const music = after.document.tracks.find((track) => track.kind === "music");
        assert(music?.kind === "music");
        // Words at 55-70 and 110-125 play at 35-50 and 70-85 after the cut. Gaps of 3 and 7
        // frames (under 300 ms) merge; the 20-frame gap before 70 does not.
        expect(music.duck).toEqual({
          depthDb: -12,
          attackFrames: 5,
          releaseFrames: 12,
          ranges: [
            { start: 5, end: 50 },
            { start: 70, end: 85 },
          ],
        });
        const again = yield* project.sounds.duckMusic(project.projectId, {}, { reply });
        expect(again).toMatchObject({ changed: false, revision: after.revision });
      }),
    ),
  );

  it.effect("says what to do first without music, without a transcript, or with a bad depth", () =>
    withProject((project) =>
      Effect.gen(function* () {
        yield* setUp(project);
        const noMusic = yield* project.sounds
          .duckMusic(project.projectId, {}, { reply })
          .pipe(Effect.flip);
        expect(noMusic.message).toBe(
          "There is no music in the edit yet. Place it with video_place_audio first.",
        );
        yield* project.sounds.placeAudio(
          project.projectId,
          { media: "bed", track: "music" },
          { reply },
        );
        const before = editJson(project.root);
        const untranscribed = yield* project.sounds
          .duckMusic(project.projectId, {}, { reply })
          .pipe(Effect.flip);
        expect(untranscribed.message).toBe(
          "Transcribe the clip first: cam has no transcript. Run video_transcribe, then duck the music again.",
        );
        const deep = yield* project.sounds
          .duckMusic(project.projectId, { depthDb: 6 }, { reply })
          .pipe(Effect.flip);
        expect(deep.message).toBe("depthDb is how far the music dips, in dB from -40 to -1.");
        expect(editJson(project.root)).toBe(before);
      }),
    ),
  );
});
