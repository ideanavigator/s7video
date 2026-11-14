// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type EditOp,
  EnvironmentId,
  type ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  ThreadId,
  validateEditDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import { layerEditTest } from "../../../edit/editHarness.testkit.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ExportService from "../../../export/ExportService.ts";
import * as MediaLibraryService from "../../../media/MediaLibraryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as TranscriptService from "../../../transcript/TranscriptService.ts";
import * as AudioTrackService from "../../../edit/AudioTrackService.ts";
import * as ZoomService from "../../../edit/ZoomService.ts";
import * as CaptionTrackService from "../../../edit/CaptionTrackService.ts";
import * as ClipPlacementService from "../../../edit/ClipPlacementService.ts";
import * as SilenceCutService from "../../../edit/SilenceCutService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-video-undo");

const media = {
  id: "cam",
  kind: "video",
  path: "assets/cam.mp4",
  fingerprint: { sha256: "ab".repeat(32), size: 4096 },
  probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
} as const;
const setup: ReadonlyArray<EditOp> = [
  { _tag: "putMedia", media },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];
const keep = (ranges: ReadonlyArray<readonly [number, number]>): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "cam",
  ranges: ranges.map(([at, duration]) => ({ in: at, duration })),
});

interface Thread {
  projectId: ProjectId;
  interactionMode: ProviderInteractionMode;
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>;
}

const scopeFor = (thread: Thread): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment-video-undo"),
  requestNamespace: "session-video-undo",
  thread: {
    threadId,
    providerSessionId: "session-video-undo",
    // The live-caller check compares this with the thread shell's provider instance.
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(thread.capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Runs once, right after the next `read` returns: a write landing between a tool's read and its step. */
interface ReadHook {
  afterRead: Effect.Effect<void> | undefined;
}

/** A wide 300-frame clip with three spoken phrases and room tone between them (S7V-061). */
const wideClip = {
  ...media,
  probe: { durationFrames: 300, hasVideo: true, hasAudio: true, width: 1894, height: 1080 },
} as const;
const PHRASES = [
  [30, 90],
  [120, 180],
  [210, 270],
] as const;
const LEVELS = Array.from({ length: 300 }, (_, frame) =>
  PHRASES.some(([from, to]) => from <= frame && frame < to) ? -18 : -50,
);
// One `levels` read gives the transcript and its cached levels, as S7V-055 reads them, so no
// measuring job runs; any engine call would be a regression.
const spokenClip = Layer.mergeAll(
  Layer.mock(EngineService.EngineService)({
    subscribeJobs: Stream.make({ type: "snapshot" as const, jobs: [] }),
    recentJobs: Effect.succeed([]),
    call: (method) => Effect.die(`unexpected quick call ${method}`),
    runJob: (input) => Effect.die(`unexpected job ${input.method}`),
  }),
  Layer.mock(TranscriptService.TranscriptService)({
    levels: () =>
      Effect.succeed({
        transcript: {
          transcriptVersion: 1,
          mediaFingerprint: wideClip.fingerprint,
          model: "test",
          revision: "test",
          fps: { num: 30, den: 1 },
          durationFrames: 300,
          words: PHRASES.map(([startFrame, endFrame], index) => ({
            text: `w${index}`,
            startFrame,
            endFrame,
            confidence: null,
            speaker: "S1",
          })),
          createdAt: "2026-11-07T00:00:00.000Z",
        },
        cached: {
          levelsVersion: 1 as const,
          mediaFingerprint: wideClip.fingerprint,
          fps: { num: 30, den: 1 },
          durationFrames: 300,
          levels: LEVELS,
        },
        measure: {
          projectId: "project" as ProjectId,
          path: "/project/assets/cam.mp4",
          cacheDir: "/project/.s7cache/transcripts",
          fingerprint: wideClip.fingerprint,
        },
      }),
  }),
);

/** The real edit services over git in a temp home, behind the video toolkit. */
const withProject = <A, E>(
  body: (input: {
    readonly root: string;
    readonly thread: Thread;
    readonly hook: ReadHook;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly call: (
      name: string,
      args?: Record<string, unknown>,
    ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
  }) => Effect.Effect<A, E, never>,
  /** "real": the real SilenceCutService over a scripted transcript and sound levels. */
  silences: "mock" | "real" = "mock",
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-undo-" });
    const thread: Thread = {
      projectId: "" as ProjectId,
      interactionMode: "default",
      capabilities: ["orchestration", "video"],
    };
    const hook: ReadHook = { afterRead: undefined };
    const editLayer = Layer.effect(
      EditDocumentService.EditDocumentService,
      Effect.map(EditDocumentService.EditDocumentService, (real) =>
        EditDocumentService.EditDocumentService.of({
          ...real,
          read: (projectId) =>
            real.read(projectId).pipe(
              Effect.tap(() => {
                const after = hook.afterRead;
                hook.afterRead = undefined;
                return after ?? Effect.void;
              }),
            ),
        }),
      ),
    ).pipe(Layer.provideMerge(layerEditTest(baseDir)));
    const services = Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.sync(() => ({
            ...McpToolAccessTestkit.liveThreadShell(id, {
              interactionMode: thread.interactionMode,
            }),
            projectId: thread.projectId,
          })),
      }),
      Layer.mock(ExportService.ExportService)({}),
      Layer.mock(MediaLibraryService.MediaLibraryService)({}),
      CaptionTrackService.layer,
      ClipPlacementService.layer,
      silences === "real"
        ? SilenceCutService.layer.pipe(Layer.provideMerge(spokenClip))
        : Layer.mergeAll(
            Layer.mock(EngineService.EngineService)({
              subscribeJobs: Stream.make({ type: "snapshot" as const, jobs: [] }),
              recentJobs: Effect.succeed([]),
              // S7V-036: the voice clip measures -20 LUFS and every other sound -10 LUFS.
              call: (method, params, success) =>
                method === "media.loudness"
                  ? Schema.decodeEffect(success)({
                      integratedLufs: String(params["path"]).endsWith("cam.mp4") ? -20 : -10,
                    }).pipe(Effect.orDie)
                  : Effect.die(`unexpected quick call ${method}`),
            }),
            Layer.mock(TranscriptService.TranscriptService)({}),
            Layer.mock(SilenceCutService.SilenceCutService)({}),
          ),
    ).pipe(Layer.provideMerge(editLayer));
    const withSound = Layer.mergeAll(AudioTrackService.layer, ZoomService.layer).pipe(
      Layer.provideMerge(services),
    );
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const server = yield* McpServer.McpServer;
      const created = yield* folders.createNamedProject({ name: "Undo test" });
      thread.projectId = created.projectId;
      const call = (name: string, args: Record<string, unknown> = {}) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(thread)),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      return yield* body({ root: created.workspaceRoot, thread, hook, edits, call });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerVideoToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(withSound),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readFile = (root: string, file: string) =>
  NodeFS.readFileSync(NodePath.join(root, file), "utf8");
const textOf = (result: McpSchema.CallToolResult) =>
  result.content.map((entry) => (entry.type === "text" ? entry.text : `[${entry.type}]`));

describe("video_undo and video_redo", () => {
  it.effect("video_undo restores the previous edit byte for byte; video_redo reapplies it", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const beforeBoth = readFile(root, "edit.json");
        const initial = yield* edits.read(thread.projectId);
        const first = yield* edits.apply(thread.projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const afterFirst = readFile(root, "edit.json");
        yield* edits.apply(thread.projectId, [keep([[0, 90]])], {
          origin: "agent",
          baseRevision: first.revision,
        });

        const once = yield* call("video_undo");
        expect(once.isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(afterFirst);
        const twice = yield* call("video_undo");
        // S7V-059: undo restores the edit, not the library, so the clip added with it stays.
        const restored = JSON.parse(readFile(root, "edit.json"));
        expect({ ...restored, media: [] }).toEqual(JSON.parse(beforeBoth));
        expect(restored.media.map((entry: { id: string }) => entry.id)).toEqual(["cam"]);
        const revision = (yield* edits.read(thread.projectId)).revision;
        expect(twice.structuredContent).toEqual({
          revision,
          message: `Undone. The edit is now revision ${revision}: 0 items on 0 tracks, 0 frames, captions off.`,
        });

        const redone = yield* call("video_redo");
        expect(redone.isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(afterFirst);
        expect(textOf(redone).join("")).toContain("Redone. The edit is now revision");
        expect(textOf(redone).join("")).toContain("1 item on 1 track, 300 frames");
      }),
    ),
  );

  // S7V-063: undo keeps clips in Assets (S7V-059), so stepping back past an import changes nothing.
  it.effect("video_undo says when a step changes nothing on the timeline", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        const imported = yield* edits.apply(thread.projectId, [{ _tag: "putMedia", media }], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const before = readFile(root, "edit.json");

        const undo = yield* call("video_undo");
        expect(undo.isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(before);
        const revision = (yield* edits.read(thread.projectId)).revision;
        expect(revision).not.toBe(imported.revision);
        expect(undo.structuredContent).toEqual({
          revision,
          message:
            "Nothing on the timeline changed: that step only added or removed a clip in Assets, and clips stay in Assets when you undo or redo. There is nothing more to undo.",
        });
        const restored = JSON.parse(readFile(root, "edit.json"));
        expect(restored.media.map((entry: { id: string }) => entry.id)).toEqual(["cam"]);
      }),
    ),
  );

  it.effect("video_redo says when a step changes nothing on the timeline", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        yield* edits.apply(thread.projectId, [{ _tag: "putMedia", media }], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        yield* call("video_undo");
        const before = readFile(root, "edit.json");

        const redo = yield* call("video_redo");
        expect(redo.isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(before);
        const revision = (yield* edits.read(thread.projectId)).revision;
        expect(redo.structuredContent).toEqual({
          revision,
          message:
            "Nothing on the timeline changed: that step only added or removed a clip in Assets, and clips stay in Assets when you undo or redo. There is nothing more to redo.",
        });
      }),
    ),
  );

  it.effect("a no-op undo with more history left says undo again", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        const first = yield* edits.apply(thread.projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        yield* edits.apply(
          thread.projectId,
          [{ _tag: "putMedia", media: { ...media, id: "mic", path: "assets/mic.mp4" } }],
          { origin: "agent", baseRevision: first.revision },
        );

        const noop = yield* call("video_undo");
        expect(textOf(noop).join("")).toContain(
          "Nothing on the timeline changed: that step only added or removed a clip in Assets, and clips stay in Assets when you undo or redo. Say undo again to go back further.",
        );
        const real = yield* call("video_undo");
        expect(textOf(real).join("")).toContain("Undone. The edit is now revision");
        const restored = JSON.parse(readFile(root, "edit.json"));
        expect(restored.tracks).toEqual([]);
        expect(restored.media.map((entry: { id: string }) => entry.id)).toEqual(["cam", "mic"]);

        // One redo per undo: the first comes back to the edit, the second over the no-op import.
        const redone = yield* call("video_redo");
        expect(textOf(redone).join("")).toContain("Redone. The edit is now revision");
        const again = yield* call("video_redo");
        expect(textOf(again).join("")).toContain(
          "Nothing on the timeline changed: that step only added or removed a clip in Assets, and clips stay in Assets when you undo or redo. There is nothing more to redo.",
        );
      }),
    ),
  );

  // S7V-063 review: undo and redo put kept clips at the end, so order alone is not a change.
  it.effect("a redo of an Assets removal that only reorders clips says nothing changed", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        const both = yield* edits.apply(
          thread.projectId,
          [
            { _tag: "putMedia", media },
            { _tag: "putMedia", media: { ...media, id: "mic", path: "assets/mic.mp4" } },
          ],
          { origin: "agent", baseRevision: initial.revision },
        );
        yield* edits.apply(thread.projectId, [{ _tag: "removeMedia", mediaId: "cam" }], {
          origin: "agent",
          baseRevision: both.revision,
        });

        const undo = yield* call("video_undo");
        expect(textOf(undo).join("")).toContain("Undone. The edit is now revision");
        const redo = yield* call("video_redo");
        const ids = JSON.parse(readFile(root, "edit.json")).media.map(
          (entry: { id: string }) => entry.id,
        );
        expect(ids).toEqual(["mic", "cam"]);
        expect(textOf(redo).join("")).toContain(
          "Nothing on the timeline changed: that step only added or removed a clip in Assets, and clips stay in Assets when you undo or redo. There is nothing more to redo.",
        );
      }),
    ),
  );

  // S7V-063 review: "changed" is decided inside the service's lock, not from the tool's earlier read.
  it.effect("an undo of a write that landed after the tool read the edit says Undone", () =>
    withProject(({ thread, hook, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        const first = yield* edits.apply(thread.projectId, [...setup, keep([[0, 300]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        let landed = false;
        hook.afterRead = edits
          .apply(thread.projectId, [keep([[0, 90]])], {
            origin: "timeline",
            baseRevision: first.revision,
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => (landed = true))),
            Effect.orDie,
          );

        // The tool saw the 300-frame edit; the timeline write makes it 90; the undo restores 300.
        const undo = yield* call("video_undo");
        expect(landed).toBe(true);
        expect(textOf(undo).join("")).toContain("Undone. The edit is now revision");
        expect(textOf(undo).join("")).toContain("1 item on 1 track, 300 frames");
      }),
    ),
  );

  it.effect("should report nothing to undo or redo and change nothing", () =>
    withProject(({ root, call }) =>
      Effect.gen(function* () {
        const before = readFile(root, "edit.json");
        const project = readFile(root, "project.json");
        const undo = yield* call("video_undo");
        expect(undo.isError).toBe(false);
        expect(undo.structuredContent).toMatchObject({ message: "There is nothing to undo." });
        const redo = yield* call("video_redo");
        expect(redo.structuredContent).toMatchObject({ message: "There is nothing to redo." });
        expect(readFile(root, "edit.json")).toBe(before);
        expect(readFile(root, "project.json")).toBe(project);
      }),
    ),
  );

  // S7V-066: plan mode is read-only for every video tool that changes the project.
  it.effect("should refuse every changing tool in a plan-mode thread and change nothing", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        yield* edits.apply(thread.projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const before = readFile(root, "edit.json");
        thread.interactionMode = "plan";
        // The service mocks die if reached, so only the plan-mode refusal can answer.
        const changing: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
          ["video_undo", {}],
          ["video_redo", {}],
          ["video_remove_silences", {}],
          ["video_export", {}],
          ["video_export_interchange", { format: "fcpxml" }],
          ["video_canvas", { ratio: "1:1" }],
          ["video_assemble", { items: [{ mediaId: "cam", in: 0, duration: 30 }] }],
          ["video_import", { path: NodePath.join(root, "clip.mp4") }],
          ["video_transcribe", { media: "cam" }],
          ["video_add_captions", {}],
          ["video_place_audio", { media: "cam" }],
          ["video_duck_music", {}],
          ["video_version_restore", { version: "v1" }],
          ["video_zoom", { range: "0-30" }],
          ["video_caption_style", { preset: "s7-box" }],
        ];
        for (const [tool, args] of changing) {
          const result = yield* call(tool, args);
          expect(result.isError, tool).toBe(true);
          expect(textOf(result).join(""), tool).toContain(
            "This thread is in plan mode, so it cannot change the project.",
          );
        }
        expect(readFile(root, "edit.json")).toBe(before);
        for (const tool of ["video_edit_read", "video_job_status", "video_versions"]) {
          expect((yield* call(tool)).isError, tool).toBe(false);
        }
      }),
    ),
  );

  // S7V-036: each placement and each duck is one assistant version, and one undo takes it out.
  it.effect("video_place_audio and video_duck_music are each one undoable step", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const clip = Buffer.from("a talking-head clip");
        NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), clip);
        for (const name of ["whoosh.wav", "bed.wav"]) {
          NodeFS.writeFileSync(NodePath.join(root, "assets", name), `a synthetic ${name}`);
        }
        const sha256 = NodeCrypto.createHash("sha256").update(clip).digest("hex");
        const cache = NodePath.join(root, ".s7cache", "transcripts");
        NodeFS.mkdirSync(cache, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(cache, `${sha256}.json`),
          JSON.stringify({
            transcriptVersion: 1,
            mediaFingerprint: { sha256, size: clip.length },
            model: "test",
            revision: "test",
            fps: { num: 30, den: 1 },
            durationFrames: 900,
            words: [
              { text: "Hello", startFrame: 10, endFrame: 20, confidence: 1, speaker: "S1" },
              { text: "there.", startFrame: 24, endFrame: 40, confidence: 1, speaker: "S1" },
              { text: "Again", startFrame: 100, endFrame: 130, confidence: 1, speaker: "S1" },
            ],
            createdAt: "2026-11-12T00:00:00.000Z",
          }),
        );
        const sound = (id: string, durationFrames: number) => ({
          _tag: "putMedia" as const,
          media: {
            id,
            kind: "audio" as const,
            path: `assets/${id}.wav`,
            label: id,
            fingerprint: { sha256: "cd".repeat(32), size: 64 },
            probe: { durationFrames, hasVideo: false, hasAudio: true },
          },
        });
        const initial = yield* edits.read(thread.projectId);
        yield* edits.apply(
          thread.projectId,
          [...setup, keep([[0, 200]]), sound("whoosh", 15), sound("bed", 900)],
          { origin: "agent", baseRevision: initial.revision },
        );
        const plain = readFile(root, "edit.json");

        const placed = yield* call("video_place_audio", { media: "whoosh", at: 24 });
        expect(placed.isError).toBe(false);
        expect(placed.structuredContent).toMatchObject({
          item: { id: "sfx1", trackId: "S1", start: 24, duration: 15, gainDb: -19 },
        });
        const withSfx = readFile(root, "edit.json");
        const [newest] = yield* edits.versions(thread.projectId);
        expect(newest!.changes).toEqual(['Added sound effect "whoosh"']);
        expect(newest!.author).toBe("assistant");

        const music = yield* call("video_place_audio", { media: "bed", track: "music" });
        expect(music.structuredContent).toMatchObject({
          item: { trackId: "M1", start: 0, duration: 200, gainDb: -28 },
        });
        const ducked = yield* call("video_duck_music");
        expect(ducked.isError).toBe(false);
        const track = JSON.parse(readFile(root, "edit.json")).tracks.find(
          (entry: { kind: string }) => entry.kind === "music",
        );
        expect(track.duck).toEqual({
          depthDb: -12,
          attackFrames: 5,
          releaseFrames: 12,
          ranges: [
            { start: 10, end: 40 },
            { start: 100, end: 130 },
          ],
        });
        expect(textOf(yield* call("video_duck_music")).join("")).toContain(
          "The music already dips 12 dB under speech in 2 places.",
        );

        // One undo each: the duck, then the music, then the sound effect.
        yield* call("video_undo");
        yield* call("video_undo");
        expect(readFile(root, "edit.json")).toBe(withSfx);
        yield* call("video_undo");
        expect(readFile(root, "edit.json")).toBe(plain);
        yield* call("video_redo");
        expect(readFile(root, "edit.json")).toBe(withSfx);
      }),
    ),
  );

  // S7V-075: captions are one assistant version; undo removes the track and redo puts it back.
  it.effect("video_add_captions adds the caption track as one undoable step", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const clip = Buffer.from("a talking-head clip");
        NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), clip);
        const sha256 = NodeCrypto.createHash("sha256").update(clip).digest("hex");
        const cache = NodePath.join(root, ".s7cache", "transcripts");
        NodeFS.mkdirSync(cache, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(cache, `${sha256}.json`),
          JSON.stringify({
            transcriptVersion: 1,
            mediaFingerprint: { sha256, size: clip.length },
            model: "test",
            revision: "test",
            fps: { num: 30, den: 1 },
            durationFrames: 900,
            words: [
              { text: "Hello", startFrame: 10, endFrame: 20, confidence: 1, speaker: "S1" },
              { text: "there.", startFrame: 22, endFrame: 30, confidence: 1, speaker: "S1" },
              { text: "Gone", startFrame: 100, endFrame: 110, confidence: 1, speaker: "S1" },
            ],
            createdAt: "2026-11-09T00:00:00.000Z",
          }),
        );
        const initial = yield* edits.read(thread.projectId);
        yield* edits.apply(thread.projectId, [...setup, keep([[0, 60]])], {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const before = readFile(root, "edit.json");

        const added = yield* call("video_add_captions");
        expect(added.isError).toBe(false);
        expect(textOf(added).join("")).toContain("Added 1 captions to the edit.");
        const captioned = readFile(root, "edit.json");
        const track = JSON.parse(captioned).tracks.find(
          (entry: { kind: string }) => entry.kind === "caption",
        );
        expect(track.items.map((item: { text: string }) => item.text)).toEqual(["Hello there."]);
        // No video file is made: captions live in the edit (AC-1).
        const exportsDir = NodePath.join(root, "exports");
        const made = NodeFS.existsSync(exportsDir) ? NodeFS.readdirSync(exportsDir) : [];
        expect(made.filter((name) => name.endsWith(".mp4"))).toEqual([]);
        const [newest] = yield* edits.versions(thread.projectId);
        expect(newest!.changes).toEqual(["Added captions"]);
        expect(newest!.author).toBe("assistant");

        expect((yield* call("video_undo")).isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(before);
        expect((yield* call("video_redo")).isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(captioned);
      }),
    ),
  );

  // S7V-037: a zoom and a caption look are each one assistant version and one undo step.
  it.effect("video_zoom and video_caption_style are each one undoable step", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const clip = Buffer.from("a talking-head clip");
        NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), clip);
        const sha256 = NodeCrypto.createHash("sha256").update(clip).digest("hex");
        const cache = NodePath.join(root, ".s7cache", "transcripts");
        NodeFS.mkdirSync(cache, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(cache, `${sha256}.json`),
          JSON.stringify({
            transcriptVersion: 1,
            mediaFingerprint: { sha256, size: clip.length },
            model: "test",
            revision: "test",
            fps: { num: 30, den: 1 },
            durationFrames: 900,
            words: [
              { text: "Hello", startFrame: 10, endFrame: 20, confidence: 1, speaker: "S1" },
              { text: "there.", startFrame: 22, endFrame: 30, confidence: 1, speaker: "S1" },
              { text: "Again", startFrame: 100, endFrame: 130, confidence: 1, speaker: "S1" },
            ],
            createdAt: "2026-11-12T00:00:00.000Z",
          }),
        );
        const initial = yield* edits.read(thread.projectId);
        yield* edits.apply(
          thread.projectId,
          [
            ...setup,
            keep([
              [0, 60],
              [90, 60],
            ]),
          ],
          { origin: "agent", baseRevision: initial.revision },
        );
        const plain = readFile(root, "edit.json");

        const zoomed = yield* call("video_zoom", { range: "20-40" });
        expect(zoomed.isError).toBe(false);
        expect(textOf(zoomed).join("")).toContain(
          "Zoomed in 1.25x from 00:00.67 to 00:01.33. It shows in the exported video, not in the player. Say undo to take it out.",
        );
        const video = JSON.parse(readFile(root, "edit.json")).tracks.find(
          (entry: { kind: string }) => entry.kind === "video",
        );
        expect(
          video.items.map((item: { start: number; duration: number; zoom?: unknown }) => [
            item.start,
            item.duration,
            item.zoom ?? null,
          ]),
        ).toEqual([
          [0, 20, null],
          [20, 20, { scale: 1.25, anchorX: 0.5, anchorY: 1 / 3, rampFrames: 0 }],
          [40, 20, null],
          [60, 60, null],
        ]);
        const withZoom = readFile(root, "edit.json");
        const [newest] = yield* edits.versions(thread.projectId);
        expect(newest!.changes).toEqual(["Zoomed in at 00:00.67"]);
        expect(newest!.author).toBe("assistant");

        // Plain refusals change nothing: a cut moment, a setting out of range, a list.
        for (const [args, says] of [
          [{ range: "65-80" }, "That moment was cut from the edit"],
          [{ range: "20-40", scale: 3 }, "scale is how far to zoom in, from 1.0"],
          [{ range: "20-40", anchorY: -0.1 }, "anchorY is the point down the frame"],
          [{ range: "9-30,60-90" }, "range is one clip-frame range"],
          [{ range: "20-40", clip: "cam", anchorX: 2 }, "anchorX is the point across the frame"],
        ] as const) {
          const refused = yield* call("video_zoom", args);
          expect(refused.isError, JSON.stringify(args)).toBe(true);
          expect(textOf(refused).join(""), JSON.stringify(args)).toContain(says);
        }
        expect(readFile(root, "edit.json")).toBe(withZoom);

        // No captions yet: the look adds them, in the same step.
        const boxed = yield* call("video_caption_style", { preset: "s7-box" });
        expect(boxed.isError).toBe(false);
        expect(textOf(boxed).join("")).toContain("Added 2 captions in the Boxed look.");
        const captions = JSON.parse(readFile(root, "edit.json")).tracks.find(
          (entry: { kind: string }) => entry.kind === "caption",
        );
        expect([captions.style, captions.metadata]).toEqual([
          "s7-box",
          { s7: { source: "transcript" } },
        ]);

        // One undo each: the look and its captions, then the zoom and its splits.
        expect((yield* call("video_undo")).isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(withZoom);
        expect((yield* call("video_undo")).isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(plain);
      }),
    ),
  );

  // S7V-061: the user can change the video's shape on request, as one undoable step.
  it.effect("video_canvas sets the shape as one undoable step, and a repeat changes nothing", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const before = readFile(root, "edit.json");
        const start = yield* edits.read(thread.projectId);
        expect(start.document.canvas).toEqual({ width: 1080, height: 1920 });

        const wide = yield* call("video_canvas", { ratio: "16:9" });
        expect(wide.isError).toBe(false);
        const after = yield* edits.read(thread.projectId);
        expect(after.document.canvas).toEqual({ width: 1920, height: 1080 });
        expect(wide.structuredContent).toEqual({
          revision: after.revision,
          message: "The video is now 16:9 (1920×1080). Say undo to put it back.",
        });

        const again = yield* call("video_canvas", { ratio: "16:9" });
        expect(again.structuredContent).toEqual({
          revision: after.revision,
          message: "The video is already 16:9 (1920×1080).",
        });

        yield* call("video_undo");
        expect(readFile(root, "edit.json")).toBe(before);
        const refused = yield* call("video_canvas", { ratio: "21:9" }).pipe(Effect.flip);
        expect(String(refused)).toMatch(/ratio/u);
      }),
    ),
  );

  // S7V-039: several clips in one edit, in order, as one undoable step.
  it.effect("should insert items in order for video_assemble", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), "cam");
        NodeFS.writeFileSync(NodePath.join(root, "assets", "broll.mp4"), "broll");
        const initial = yield* edits.read(thread.projectId);
        const ready = yield* edits.apply(
          thread.projectId,
          [
            ...setup,
            { _tag: "putMedia", media: { ...media, id: "broll", path: "assets/broll.mp4" } },
            keep([[0, 30]]),
          ],
          { origin: "agent", baseRevision: initial.revision },
        );
        const before = readFile(root, "edit.json");

        const result = yield* call("video_assemble", {
          items: [
            { mediaId: "broll", in: 100, duration: 20 },
            { mediaId: "cam", in: 300, duration: 10 },
            { mediaId: "broll", in: 0, duration: 15 },
          ],
        });
        expect(result.isError, textOf(result).join("")).toBe(false);
        const after = yield* edits.read(thread.projectId);
        expect(after.revision).toBe(ready.revision + 1);
        const { itemIds } = result.structuredContent as { itemIds: string[] };
        expect(result.structuredContent).toEqual({ revision: after.revision, itemIds });
        const track = after.document.tracks[0]!;
        const placed =
          track.kind === "video"
            ? track.items.map((item) => [item.media, item.start, item.duration, item.in])
            : [];
        expect(placed).toEqual([
          ["cam", 0, 30, 0],
          ["broll", 30, 20, 100],
          ["cam", 50, 10, 300],
          ["broll", 60, 15, 0],
        ]);
        expect(after.document.tracks[0]!.items.slice(1).map((item) => item.id)).toEqual(itemIds);

        // `at` inserts mid-track and pushes later items right.
        const inserted = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 500, duration: 5 }],
          at: 30,
        });
        expect(inserted.isError, textOf(inserted).join("")).toBe(false);
        const moved = yield* edits.read(thread.projectId);
        expect(moved.document.tracks[0]!.items.map((item) => item.start)).toEqual([
          0, 30, 35, 55, 65,
        ]);

        // One undo per call.
        yield* call("video_undo");
        yield* call("video_undo");
        expect(readFile(root, "edit.json")).toBe(before);

        // `at` inside an item is refused and changes nothing.
        const inside = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 0, duration: 5 }],
          at: 12,
        });
        expect(textOf(inside).join("")).toBe(
          "at must be where a video item starts, or the end of the edit (frame 30).",
        );
        expect(readFile(root, "edit.json")).toBe(before);

        // S7V-034: a mid-edit `at` moves every later item on every track in step, caption words
        // and markers included; an item running across `at` is refused.
        const captioned = yield* edits.read(thread.projectId);
        yield* edits.apply(
          thread.projectId,
          [
            {
              _tag: "addTrack",
              track: {
                kind: "caption",
                id: "C1",
                items: [
                  {
                    id: "cap",
                    start: 20,
                    duration: 10,
                    text: "hi",
                    words: [{ text: "hi", start: 22, duration: 4 }],
                  },
                ],
              },
            },
            { _tag: "setMarkers", markers: [{ id: "mk", start: 25, duration: 0, label: "Hook" }] },
          ],
          { origin: "agent", baseRevision: captioned.revision },
        );
        const withCaption = readFile(root, "edit.json");
        const shifted = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 0, duration: 5 }],
          at: 0,
        });
        expect(shifted.isError, textOf(shifted).join("")).toBe(false);
        const afterShift = (yield* edits.read(thread.projectId)).document;
        expect(afterShift.tracks.map((entry) => entry.items.map((item) => item.start))).toEqual([
          [0, 5],
          [25],
        ]);
        expect(afterShift.tracks[1]!.items[0]).toMatchObject({
          words: [{ text: "hi", start: 27, duration: 4 }],
        });
        expect(afterShift.markers).toEqual([{ id: "mk", start: 30, duration: 0, label: "Hook" }]);
        yield* call("video_undo");
        expect(readFile(root, "edit.json")).toBe(withCaption);
        const uncut = yield* edits.read(thread.projectId);
        const videoId = uncut.document.tracks[0]!.items[0]!.id;
        yield* edits.apply(
          thread.projectId,
          [{ _tag: "splitItem", itemId: videoId, atFrame: 25 }],
          {
            origin: "agent",
            baseRevision: uncut.revision,
          },
        );
        const cut = readFile(root, "edit.json");
        const across = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 0, duration: 5 }],
          at: 25,
        });
        expect(textOf(across).join("")).toBe(
          `"cap" runs across frame 25, so clips can't be added there. Pick a frame where it has ended, or the end (frame 30).`,
        );
        expect(readFile(root, "edit.json")).toBe(cut);
        yield* call("video_undo");
        yield* call("video_undo");

        for (const [items, message] of [
          [[{ mediaId: "nope", in: 0, duration: 5 }], "There is no file at nope"],
          [[{ mediaId: "cam", in: 890, duration: 30 }], ""],
          [[], "at least one"],
        ] as const) {
          const refused = yield* call("video_assemble", { items });
          expect(refused.isError, JSON.stringify(items)).toBe(true);
          expect(textOf(refused).join("")).toContain(message);
        }
        expect(readFile(root, "edit.json")).toBe(before);
      }),
    ),
  );

  // S7V-093: a new project's edit has no tracks; the first assemble adds V1 in the same step.
  it.effect("video_assemble on an edit with no tracks adds V1 and the parts as one step", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), "cam");
        const initial = yield* edits.read(thread.projectId);
        const imported = yield* edits.apply(
          thread.projectId,
          [{ _tag: "putMedia", media: wideClip }],
          { origin: "import", baseRevision: initial.revision },
        );
        expect(imported.document.tracks).toEqual([]);
        const before = readFile(root, "edit.json");

        // Only the edit's end, frame 0, is a place to add on an empty edit; nothing is written.
        const past = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 0, duration: 300 }],
          at: 30,
        });
        expect(past.isError).toBe(true);
        expect(textOf(past).join("")).toBe(
          "at must be where a video item starts, or the end of the edit (frame 0).",
        );
        expect(readFile(root, "edit.json")).toBe(before);

        const result = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 0, duration: 300 }],
        });
        expect(result.isError, textOf(result).join("")).toBe(false);
        const after = yield* edits.read(thread.projectId);
        expect(after.revision).toBe(imported.revision + 1);
        const { itemIds } = result.structuredContent as { itemIds: string[] };
        expect(result.structuredContent).toEqual({ revision: after.revision, itemIds });
        expect(after.document.tracks).toEqual([
          {
            kind: "video",
            id: "V1",
            items: [{ id: itemIds[0], media: "cam", start: 0, duration: 300, in: 0 }],
          },
        ]);
        // The first clip gives the edit its shape, as the first silence cut does (S7V-061).
        expect(after.document.canvas).toEqual({ width: 1894, height: 1080 });
        expect(validateEditDocument(JSON.parse(readFile(root, "edit.json"))).ok).toBe(true);

        // One undo takes the clip, the track and the shape back off together.
        const undone = yield* call("video_undo");
        expect(undone.isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(before);
      }),
    ),
  );

  it.effect("video_assemble on an audio-only edit adds V1 and leaves the music as it is", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), "cam");
        const song = {
          id: "song",
          kind: "audio",
          path: "assets/song.mp3",
          fingerprint: { sha256: "cd".repeat(32), size: 2048 },
          probe: { durationFrames: 600, hasVideo: false, hasAudio: true },
        } as const;
        const music = {
          kind: "music" as const,
          id: "M1",
          items: [{ id: "bed", media: "song", start: 0, duration: 600, in: 0, gainDb: -18 }],
        };
        const initial = yield* edits.apply(
          thread.projectId,
          [
            { _tag: "putMedia", media },
            { _tag: "putMedia", media: song },
            { _tag: "addTrack", track: music },
          ],
          { origin: "agent", baseRevision: (yield* edits.read(thread.projectId)).revision },
        );

        const result = yield* call("video_assemble", {
          items: [{ mediaId: "cam", in: 0, duration: 90 }],
          at: 0,
        });
        expect(result.isError, textOf(result).join("")).toBe(false);
        const after = yield* edits.read(thread.projectId);
        expect(after.revision).toBe(initial.revision + 1);
        expect(after.document.tracks.map((track) => [track.kind, track.id])).toEqual([
          ["music", "M1"],
          ["video", "V1"],
        ]);
        expect(after.document.tracks[0]).toEqual(music);
        expect(after.document.tracks[1]!.items.map((item) => [item.start, item.duration])).toEqual([
          [0, 90],
        ]);
        expect(validateEditDocument(JSON.parse(readFile(root, "edit.json"))).ok).toBe(true);
      }),
    ),
  );

  // Round-2 review: "make it a reel and remove the silences" on a wide clip stays a reel.
  it.effect("video_canvas on the default shape still keeps the first cut from reshaping", () =>
    withProject(
      ({ root, thread, edits, call }) =>
        Effect.gen(function* () {
          NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(root, "assets", "cam.mp4"), "original media");
          const initial = yield* edits.read(thread.projectId);
          yield* edits.apply(thread.projectId, [{ _tag: "putMedia", media: wideClip }], {
            origin: "import",
            baseRevision: initial.revision,
          });
          const start = yield* edits.read(thread.projectId);
          expect(start.document.canvas).toEqual({ width: 1080, height: 1920 });

          const reel = yield* call("video_canvas", { ratio: "9:16" });
          expect(reel.isError).toBe(false);
          expect(reel.structuredContent).toMatchObject({
            revision: start.revision + 1,
            message: "The video is now 9:16 (1080×1920). Say undo to put it back.",
          });

          const cut = yield* call("video_remove_silences", {});
          expect(cut.isError, textOf(cut).join("")).toBe(false);
          const after = yield* edits.read(thread.projectId);
          expect(after.document.tracks[0]?.items.length).toBe(3);
          expect(after.document.canvas).toEqual({ width: 1080, height: 1920 });
        }),
      "real",
    ),
  );

  it.effect("should hide tools without an edit project", () =>
    withProject(({ thread, call }) =>
      Effect.gen(function* () {
        thread.capabilities = ["orchestration"];
        for (const tool of ["video_undo", "video_redo"]) {
          const error = yield* call(tool).pipe(Effect.flip);
          expect(String(error), tool).toContain(`Tool '${tool}' not found`);
        }
      }),
    ),
  );

  it.effect("should not touch files outside edit.json and project.json", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        const first = yield* edits.apply(thread.projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        yield* edits.apply(thread.projectId, [keep([[0, 30]])], {
          origin: "agent",
          baseRevision: first.revision,
        });
        const kept: Record<string, string> = {
          "styles/brand.json": '{"colour":"teal"}\n',
          "README.md": "# My own notes\n",
        };
        for (const [file, text] of Object.entries(kept)) {
          NodeFS.writeFileSync(NodePath.join(root, file), text);
        }
        yield* call("video_undo");
        yield* call("video_redo");
        yield* call("video_undo");
        for (const [file, text] of Object.entries(kept)) {
          expect(readFile(root, file), file).toBe(text);
        }
      }),
    ),
  );
});

// S7V-070: versions by plain words. The harness's tool calls all come from one chat reply.
describe("video_versions and video_version_restore", () => {
  it.effect(
    "video_versions lists the newest 20 and finds one by number or name, in plan mode",
    () =>
      withProject(({ thread, edits, call }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(thread.projectId);
          let revision = (yield* edits.apply(thread.projectId, [...setup, keep([[0, 300]])], {
            origin: "agent",
            baseRevision: initial.revision,
            summary: "Kept the whole clip",
          })).revision;
          for (let n = 2; n <= 22; n++) {
            revision = (yield* edits.apply(thread.projectId, [keep([[0, 300 - n]])], {
              origin: "timeline",
              baseRevision: revision,
            })).revision;
          }
          yield* edits.tagVersion(thread.projectId, 1, "first cut");
          yield* edits.tagVersion(thread.projectId, 5, "12");
          thread.interactionMode = "plan";

          const listed = yield* call("video_versions");
          expect(listed.isError).toBe(false);
          // A blank version is no version: it lists.
          const blank = yield* call("video_versions", { version: "  " });
          expect(blank.structuredContent).toEqual(listed.structuredContent);
          const lines = (listed.structuredContent as { versions: ReadonlyArray<{ n: number }> })
            .versions;
          expect(lines.map((line) => line.n)).toEqual(
            Array.from({ length: 20 }, (_, index) => 22 - index),
          );
          expect(lines[0]).toMatchObject({ n: 22, author: "you", main: true });
          expect(lines.at(-1)).not.toHaveProperty("main");

          const named = yield* call("video_versions", { version: "First Cut" });
          expect(named.structuredContent).toEqual({
            version: {
              n: 1,
              tag: "first cut",
              author: "assistant",
              at: expect.any(String),
              change: "Kept the whole clip",
              details:
                'v1 "first cut", by the assistant. Changes: Kept the whole clip. 1 kept piece of video, 300 frames (10.0 s), captions off.',
            },
          });
          for (const ref of ["v12", "12"]) {
            const numbered = yield* call("video_versions", { version: ref });
            const details = (
              numbered.structuredContent as { version: { n: number; details: string } }
            ).version;
            expect(details.n, ref).toBe(12);
            expect(details.details.includes("v5 also has this name"), ref).toBe(ref === "12");
          }
          for (const [ref, message] of [
            ["v999", "There is no version v999 in this project."],
            ["nope", 'No version in this project is named "nope".'],
          ] as const) {
            const missing = yield* call("video_versions", { version: ref });
            expect(missing.isError, ref).toBe(true);
            expect(textOf(missing), ref).toEqual([message]);
          }
        }),
      ),
  );

  it.effect("video_version_restore adds one version equal to the chosen one, and undoes", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        const first = yield* edits.apply(thread.projectId, [...setup, keep([[0, 300]])], {
          origin: "timeline",
          baseRevision: initial.revision,
        });
        const v1Edit = readFile(root, "edit.json");
        yield* edits.apply(thread.projectId, [keep([[0, 90]])], {
          origin: "timeline",
          baseRevision: first.revision,
        });
        const v2Edit = readFile(root, "edit.json");
        const before = yield* edits.versions(thread.projectId);

        const restored = yield* call("video_version_restore", { version: "v1" });
        expect(restored.isError).toBe(false);
        expect(readFile(root, "edit.json")).toBe(v1Edit);
        const after = yield* edits.read(thread.projectId);
        expect(restored.structuredContent).toEqual({
          revision: after.revision,
          version: 3,
          message: `v1 is now the main version, saved as v3: revision ${after.revision}: 1 item on 1 track, 300 frames, captions off. Say undo to go back.`,
        });
        const versions = yield* edits.versions(thread.projectId);
        expect(versions[0]).toMatchObject({
          n: 3,
          author: "assistant",
          threadId,
          changes: ["Restored from v1"],
          restoredFrom: 1,
        });
        expect(versions.slice(1)).toEqual(
          before.map((version) => ({ ...version, current: false })),
        );

        for (const [ref, message] of [
          ["v3", "v3 is already the main version; nothing changed."],
          ["1", "v1 is the same as the main version (v3); nothing changed."],
        ] as const) {
          const same = yield* call("video_version_restore", { version: ref });
          expect(same.structuredContent, ref).toEqual({
            revision: after.revision,
            version: 3,
            message,
          });
        }
        expect((yield* edits.versions(thread.projectId)).length).toBe(3);

        const blank = yield* call("video_version_restore", { version: " " });
        expect(blank.isError).toBe(true);
        expect(textOf(blank)).toEqual(["Say which version to make main: v12 or its name."]);
        expect((yield* edits.versions(thread.projectId)).length).toBe(3);

        const missing = yield* call("video_version_restore", { version: "the tight cut" });
        expect(missing.isError).toBe(true);
        expect(textOf(missing)).toEqual(['No version in this project is named "the tight cut".']);

        yield* call("video_undo");
        expect(readFile(root, "edit.json")).toBe(v2Edit);
      }),
    ),
  );

  it.effect(
    "a restore after another change in the same reply folds into that reply's version",
    () =>
      withProject(({ root, thread, edits, call }) =>
        Effect.gen(function* () {
          const initial = yield* edits.read(thread.projectId);
          yield* edits.apply(thread.projectId, [...setup, keep([[0, 300]])], {
            origin: "timeline",
            baseRevision: initial.revision,
          });
          const v1Edit = readFile(root, "edit.json");
          yield* call("video_canvas", { ratio: "1:1" });
          const restored = yield* call("video_version_restore", { version: "v1" });
          expect(restored.isError).toBe(false);
          expect(readFile(root, "edit.json")).toBe(v1Edit);
          const versions = yield* edits.versions(thread.projectId);
          expect(versions.map((version) => version.n)).toEqual([2, 1]);
          expect(versions[0]).toMatchObject({
            author: "assistant",
            changes: ["Made the video 1:1 (1080×1080)", "Restored from v1"],
            restoredFrom: 1,
          });
        }),
      ),
  );
});
