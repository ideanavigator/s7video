// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Builds project folders, symlinks and PNG files on disk.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type EditDocument,
  type EditMedia,
  type EditSnapshot,
  EditUnavailableError,
  EngineError,
  type EngineJob,
  EngineJobId,
  type EngineJobsEvent,
  EnvironmentId,
  type ExportStartInput,
  type MediaFrameInput,
  type MediaProbeResult,
  ProjectId,
  ProviderInstanceId,
  CaptionsError,
  SoundError,
  SilenceCutError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../../config.ts";
import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import * as AudioTrackService from "../../../edit/AudioTrackService.ts";
import * as CaptionTrackService from "../../../edit/CaptionTrackService.ts";
import * as SilenceCutService from "../../../edit/SilenceCutService.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ExportService from "../../../export/ExportService.ts";
import * as MediaLibraryService from "../../../media/MediaLibraryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TranscriptService from "../../../transcript/TranscriptService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { NOT_IN_PROJECT, NOT_SHARED } from "../../VideoProjectScope.ts";
import {
  cleanupHint,
  editDurationFrames,
  KEEP_FORMAT,
  KEEP_OVERLAP,
  NO_ROOM_TO_COPY,
} from "./handlers.ts";
import { VideoToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-video-test");
const projectA = ProjectId.make("project-video-a");
const projectB = ProjectId.make("project-video-b");
const threadA = ThreadId.make("thread-video-a");
const threadB = ThreadId.make("thread-video-b");
const threadPlain = ThreadId.make("thread-plain");

const scopeFor = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration", "video"],
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId,
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
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

/** A 24-byte PNG header is enough: the handler reads the file, it does not decode it. */
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);

const fingerprint = { sha256: "ab".repeat(32), size: 4096 };
const media = (entry: Partial<EditMedia> & Pick<EditMedia, "id">): EditMedia => ({
  kind: "video",
  fingerprint,
  probe: { hasVideo: true, hasAudio: true, durationFrames: 300, fps: { num: 30, den: 1 } },
  ...entry,
});

const documentWith = (
  entries: ReadonlyArray<EditMedia>,
  tracks: EditDocument["tracks"] = [],
): EditDocument => ({
  version: 1,
  fps: { num: 30, den: 1 },
  canvas: { width: 1080, height: 1920 },
  media: entries,
  tracks,
  markers: [],
  metadata: {},
});

const probeResult = (path: string): MediaProbeResult => ({
  path,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  sizeBytes: 4096,
  bitRate: 1_000_000,
  durationFrames: 300,
  video: {
    index: 0,
    codec: "h264",
    profile: "High",
    width: 1280,
    height: 720,
    pixelFormat: "yuv420p",
    frameRate: { num: 25, den: 1 },
    averageFrameRate: { num: 25, den: 1 },
    variableFrameRate: false,
    timeBase: { num: 1, den: 12_800 },
    firstPts: 0,
    lastPts: 153_088,
    frameCount: 300,
    durationFrames: 300,
    rotation: 0,
    color: { space: null, transfer: null, primaries: null, range: null },
  },
  audio: null,
});

interface Fixture {
  /** Real paths: macOS temp folders sit behind the /var -> /private/var symlink. */
  readonly rootA: string;
  readonly rootB: string;
  readonly outside: string;
  readonly calls: Array<readonly ["probe", string] | readonly ["frame", MediaFrameInput]>;
  readonly cancelled: Array<string>;
  readonly exports: Array<ExportStartInput>;
  readonly engine: { failNextProbe: boolean; modelsReady: boolean };
  readonly started: Array<{ readonly kind: string; readonly projectId: ProjectId | undefined }>;
  readonly documents: Map<ProjectId, EditDocument>;
  /** The server's chat attachment folder, with one file shared in thread A and one in B. */
  readonly attachmentsDir: string;
  readonly sharedInA: string;
  readonly sharedInB: string;
  readonly imports: Array<{
    sourcePath: string;
    mode: string;
    origin: string | undefined;
    label: string | undefined;
  }>;
  readonly silences: Array<SilenceCutService.RemoveSilencesInput>;
  readonly sounds: Array<readonly [string, ProjectId, unknown]>;
  diskShort: boolean;
  /** Runs as each job subscription starts. */
  onSubscribe: Effect.Effect<void>;
  /** Jobs that ended recently, as `EngineService.recentJobs` answers. */
  recent: Array<EngineJob>;
  /** The history size the edit snapshot reports as due a cleanup question (S7V-050). */
  cleanup: { versions: number; bytes: number } | undefined;
}

const makeFixture = (): Fixture => {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-vt-")));
  const rootA = NodePath.join(base, "Project A");
  const rootB = NodePath.join(base, "Project B");
  const outside = NodePath.join(base, "Desktop");
  for (const folder of [rootA, rootB, outside]) {
    NodeFS.mkdirSync(NodePath.join(folder, "assets"), { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(rootA, "assets", "clip.mp4"), "clip");
  NodeFS.writeFileSync(NodePath.join(rootB, "assets", "other.mp4"), "other");
  NodeFS.writeFileSync(NodePath.join(outside, "secret.mp4"), "secret");
  NodeFS.writeFileSync(NodePath.join(outside, "imported.mov"), "imported");
  const attachmentsDir = NodePath.join(base, "state", "attachments");
  NodeFS.mkdirSync(attachmentsDir, { recursive: true });
  const sharedInA = NodePath.join(
    attachmentsDir,
    `${threadA}-5b8c0f3e-2a8d-4f7e-9c1a-0d2e3f4a5b6c.m4a`,
  );
  const sharedInB = NodePath.join(
    attachmentsDir,
    `${threadB}-6c9d1a4f-3b9e-4a8f-8d2b-1e3f4a5b6c7d.m4a`,
  );
  NodeFS.writeFileSync(sharedInA, "sound");
  NodeFS.writeFileSync(sharedInB, "sound");
  NodeFS.symlinkSync(
    NodePath.join(outside, "secret.mp4"),
    NodePath.join(rootA, "assets", "link.mp4"),
  );
  NodeFS.symlinkSync(outside, NodePath.join(rootA, "assets", "desktop"));
  NodeFS.symlinkSync(
    NodePath.join(outside, "nothing-here.mp4"),
    NodePath.join(rootA, "assets", "dangling.mp4"),
  );
  NodeFS.symlinkSync("dangling.mp4", NodePath.join(rootA, "assets", "chained.mp4"));
  NodeFS.symlinkSync("gone.mp4", NodePath.join(rootA, "assets", "dangling-inside.mp4"));
  // Reached through assets/desktop, a lexical resolve would land inside Project A.
  NodeFS.symlinkSync("../secret/missing.mp4", NodePath.join(outside, "rel-link.mp4"));
  const documents = new Map<ProjectId, EditDocument>([
    [
      projectA,
      documentWith([
        media({ id: "cam", path: "assets/clip.mp4" }),
        media({ id: "ref", reference: NodePath.join(outside, "imported.mov") }),
        // A tampered edit.json whose relative path climbs out of the project.
        media({ id: "escape", path: "../Desktop/secret.mp4" }),
        media({ id: "linked", path: "assets/link.mp4" }),
      ]),
    ],
    [projectB, documentWith([media({ id: "other", path: "assets/other.mp4" })])],
  ]);
  return {
    rootA,
    rootB,
    outside,
    calls: [],
    cancelled: [],
    exports: [],
    engine: { failNextProbe: false, modelsReady: true },
    started: [],
    documents,
    attachmentsDir,
    sharedInA,
    sharedInB,
    imports: [],
    silences: [],
    sounds: [],
    diskShort: false,
    onSubscribe: Effect.void,
    recent: [],
    cleanup: undefined,
  };
};

const job = (id: string, projectId: ProjectId): EngineJob => ({
  id: EngineJobId.make(id),
  kind: "transcribe",
  progress: 0.25,
  stage: "decode",
  state: "running",
  projectId,
});

const layerFor = (fixture: Fixture, cancelSignal: Deferred.Deferred<string>) => {
  const roots = new Map([
    [projectA, fixture.rootA],
    [projectB, fixture.rootB],
    [ProjectId.make("project:mcp-test"), NodeFS.realpathSync(NodeOS.tmpdir())],
  ]);
  const projectOf = new Map([
    [threadA, projectA],
    [threadB, projectB],
  ]);
  const jobs = [job("engine-job-1", projectA), job("engine-job-2", projectB)];
  // Like the real service: the export's engine job carries the project it was started for.
  const exportService = Layer.mock(ExportService.ExportService)({
    start: (input) =>
      Effect.suspend(() => {
        if (!fixture.documents.has(input.projectId)) {
          return Effect.fail(
            new EditUnavailableError({
              projectId: input.projectId,
              reason: "not-an-edit-project",
              explanation: "This project has no edit yet.",
            }),
          );
        }
        fixture.exports.push(input);
        const id = EngineJobId.make(`engine-job-export-${fixture.exports.length}`);
        jobs.push({ ...job(id, input.projectId), kind: "export", stage: "render" });
        return Effect.succeed({ jobId: id, path: "exports/my-reel-20261106-0930.mp4" });
      }),
  });
  return Layer.mergeAll(
    exportService,
    Layer.mock(SilenceCutService.SilenceCutService)({
      removeSilences: (input) =>
        Effect.suspend(() => {
          fixture.silences.push(input);
          return input.media === "silent"
            ? Effect.fail(
                new SilenceCutError({
                  reason: "no-speech",
                  detail: "silent has no speech in its transcript.",
                }),
              )
            : Effect.succeed({
                media: input.media ?? "cam",
                removedSeconds: 3.2,
                cuts: 4,
                keptSegments: 5,
                shortestSegmentFrames: 12,
                keptRequests: input.keep?.length ?? 0,
                message: "Removed 3.2 s in 4 cuts.",
                revision: 8,
                changed: true,
              });
        }),
    }),
    // Project B has no transcript and no music: the service's plain refusals.
    Layer.mock(AudioTrackService.AudioTrackService)({
      placeAudio: (projectId, input) => {
        fixture.sounds.push(["place", projectId, input]);
        return projectId === projectB
          ? Effect.fail(
              new SoundError({
                reason: "cut",
                detail: "Frame 40 of other was cut from the edit, so nothing was added.",
              }),
            )
          : Effect.succeed({
              revision: 10,
              item: { id: "sfx1", trackId: "S1", start: 42, duration: 5, gainDb: -5.3 },
              message: 'Added "whoosh" on the sound effect track at 1.8 s, 9 dB under the voice.',
            });
      },
      duckMusic: (projectId, input) => {
        fixture.sounds.push(["duck", projectId, input]);
        return projectId === projectB
          ? Effect.fail(
              new SoundError({
                reason: "no-music",
                detail: "There is no music in the edit yet. Place it with video_place_audio first.",
              }),
            )
          : Effect.succeed({
              revision: 11,
              ranges: 13,
              changed: true,
              message: "The music now dips 12 dB under speech in 13 places.",
            });
      },
    }),
    Layer.mock(CaptionTrackService.CaptionTrackService)({
      addCaptions: (projectId) =>
        projectId === projectB
          ? Effect.fail(
              new CaptionsError({
                reason: "no-transcript",
                detail: "Transcribe the clip first: cam has no transcript.",
              }),
            )
          : Effect.succeed({ revision: 9, captions: 12, changed: true }),
    }),
    Layer.mock(MediaLibraryService.MediaLibraryService)({
      plan: (input) =>
        Effect.succeed(
          fixture.diskShort
            ? {
                suggestedMode: "reference",
                reason: "A copy needs 1.0 GB and should leave 15.0 GB free.",
                totalBytes: input.sourcePaths.length,
                freeBytes: 0,
              }
            : { suggestedMode: "copy", totalBytes: input.sourcePaths.length, freeBytes: 1e12 },
        ),
      import: (input) =>
        Effect.sync(() => {
          fixture.imports.push({
            sourcePath: input.sourcePath,
            mode: input.mode,
            origin: input.origin,
            label: input.label,
          });
          return { mediaId: "shared-sound" };
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...McpToolAccessTestkit.liveThreadShell(threadId),
          // The provider that owns the run, as in scopeFor, so writing tools see a live caller.
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          projectId: projectOf.get(threadId) ?? ProjectId.make("project:mcp-test"),
        }),
      // The user's message in thread A carries the shared file under its original name.
      getProjectThreadRecords: (input) =>
        Effect.succeed({
          messages:
            input.threadId === threadA
              ? [
                  {
                    attachments: [
                      {
                        type: "file",
                        id: NodePath.basename(fixture.sharedInA).replace(/\.m4a$/u, ""),
                        name: "voice over.m4a",
                        mimeType: "audio/mp4",
                        sizeBytes: 5,
                      },
                    ],
                  },
                ]
              : [],
        } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          Option.fromNullishOr(roots.get(projectId)).pipe(
            Option.map((workspaceRoot) => ({ workspaceRoot }) as never),
          ),
        ),
    }),
    Layer.mock(EditDocumentService.EditDocumentService)({
      read: (projectId) =>
        Effect.succeed({
          revision: 7,
          document: fixture.documents.get(projectId) ?? documentWith([]),
          canUndo: true,
          canRedo: false,
          ...(fixture.cleanup === undefined ? {} : { cleanup: fixture.cleanup }),
        } satisfies EditSnapshot),
      versions: () => Effect.succeed([]),
    }),
    Layer.mock(EngineService.EngineService)({
      probe: (input) =>
        Effect.suspend(() => {
          fixture.calls.push(["probe", input.path]);
          if (fixture.engine.failNextProbe) {
            fixture.engine.failNextProbe = false;
            return Effect.fail(new EngineError({ reason: "crashed", method: "media.probe" }));
          }
          return Effect.succeed(probeResult(input.path));
        }),
      frame: (input) =>
        Effect.sync(() => {
          fixture.calls.push(["frame", input]);
          const file = NodePath.join(fixture.outside, `frame-${input.frame}.png`);
          NodeFS.writeFileSync(file, png);
          return { path: file, frame: input.frame, rate: input.rate, width: 640, height: 360 };
        }),
      subscribeJobs: Stream.unwrap(
        Effect.suspend(() => fixture.onSubscribe).pipe(
          Effect.as(
            Stream.concat(
              Stream.make({ type: "snapshot", jobs } as EngineJobsEvent),
              Stream.fromEffect(Deferred.await(cancelSignal)).pipe(
                Stream.map((id): EngineJobsEvent => ({
                  type: "updated",
                  job: { ...jobs.find((entry) => entry.id === id)!, state: "cancelled" },
                })),
              ),
            ),
          ),
        ),
      ),
      recentJobs: Effect.sync(() => fixture.recent),
      cancelJob: (jobId) =>
        Effect.sync(() => fixture.cancelled.push(jobId)).pipe(
          Effect.andThen(Deferred.succeed(cancelSignal, jobId)),
        ),
      call: (method) => {
        if (method !== "transcribe.models.status") return Effect.die(`unexpected ${method}`);
        const ready = fixture.engine.modelsReady;
        const profile = { models: [], sizeBytes: 1, ready };
        return Effect.succeed({
          models: {},
          profiles: { default: profile, light: profile },
          loadedProfile: null,
        } as never);
      },
      startJob: (input) =>
        Effect.sync(() => {
          fixture.started.push({ kind: input.kind, projectId: input.projectId });
          return EngineJobId.make("engine-job-9");
        }),
    }),
  );
};

/** The real TranscriptService over the mocked project, edit and engine services. */
const layerWithTranscripts = (fixture: Fixture, cancelSignal: Deferred.Deferred<string>) =>
  TranscriptService.layerWith({ totalMemoryBytes: 36 * 1024 ** 3 }).pipe(
    Layer.provideMerge(layerFor(fixture, cancelSignal)),
    // The test config, with chat attachments in the fixture's folder for video_import.
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, attachmentsDir: fixture.attachmentsDir };
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "video-transcript-" }))),
    ),
  );

const withTools = <A, E>(
  body: (input: {
    readonly fixture: Fixture;
    readonly call: (
      threadId: ThreadId,
      name: string,
      args: object,
      capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
      client?: McpInvocationContext.McpThreadInvocationScope["client"],
    ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
    readonly server: McpServer.McpServer["Service"];
  }) => Effect.Effect<A, E, McpServer.McpServer>,
) =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const cancelSignal = yield* Deferred.make<string>();
    const services = layerWithTranscripts(fixture, cancelSignal);
    return yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        threadId: ThreadId,
        name: string,
        args: object,
        capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
        caller?: McpInvocationContext.McpThreadInvocationScope["client"],
      ) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...scopeFor(threadId, capabilities),
            client: caller,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      return yield* body({ fixture, call, server });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerVideoToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(services),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() =>
          NodeFS.rmSync(NodePath.dirname(fixture.rootA), { recursive: true, force: true }),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const textOf = (result: McpSchema.CallToolResult) =>
  result.content.map((entry) => (entry.type === "text" ? entry.text : `[${entry.type}]`));

describe("video toolkit", () => {
  it.effect("video toolkit lists its tools with video_ names", () =>
    withTools(({ server }) =>
      Effect.sync(() => {
        const tools = server.tools.map(({ tool }) => tool);
        expect(tools.map((tool) => tool.name).toSorted()).toEqual([
          "video_add_captions",
          "video_assemble",
          "video_canvas",
          "video_duck_music",
          "video_edit_read",
          "video_export",
          "video_frame",
          "video_import",
          "video_job_cancel",
          "video_job_status",
          "video_place_audio",
          "video_probe",
          "video_redo",
          "video_remove_silences",
          "video_transcribe",
          "video_transcript_read",
          "video_undo",
          "video_version_restore",
          "video_versions",
        ]);
        // ToolSearch finds deferred tools by these words, so each says what it reads.
        for (const tool of tools) {
          expect(tool.description).toMatch(/\bvideo\b/u);
        }
        const described = Object.fromEntries(tools.map((tool) => [tool.name, tool.description]));
        expect(described.video_probe).toContain("clip");
        expect(described.video_frame).toContain("frame");
        expect(described.video_edit_read).toContain("edit");
        expect(described.video_job_status).toContain("job");
        expect(described.video_job_cancel).toContain("job");
        expect(described.video_export).toContain("job");
        // S7V-061: exports and shape changes are user-triggered only.
        expect(described.video_export).toContain("only if user asks");
        expect(described.video_canvas).toContain("only if user asks");
        const exportTool = tools.find((tool) => tool.name === "video_export");
        expect(Object.keys(exportTool?.inputSchema.properties ?? {})).toEqual(["captions"]);
        expect(described.video_transcribe).toContain("Transcribe");
        expect(described.video_transcript_read).toContain("transcript");
        expect(described.video_undo).toMatch(/\bundo\b.*\bedit\b/iu);
        expect(described.video_redo).toMatch(/\bredo\b.*\bedit\b/iu);
        // S7V-027: user-triggered only; the agent never cuts silences on its own.
        expect(described.video_remove_silences).toContain("only if user asks");
        expect(described.video_assemble).toContain("only if user asks");
      }),
    ),
  );

  it.effect("video_import imports a file the user shared in this thread", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const result = yield* call(threadA, "video_import", { path: fixture.sharedInA });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ media: "shared-sound" });
        // A file already in the project folder may be imported too.
        const inProject = NodePath.join(fixture.rootA, "assets", "clip.mp4");
        const local = yield* call(threadA, "video_import", { path: inProject });
        expect(local.isError).toBe(false);
        expect(fixture.imports).toEqual([
          // A chat attachment keeps the name it was sent with, not its stored id.
          {
            sourcePath: fixture.sharedInA,
            mode: "copy",
            origin: "agent",
            label: "voice over.m4a",
          },
          { sourcePath: inProject, mode: "copy", origin: "agent", label: undefined },
        ]);
      }),
    ),
  );

  it.effect("a change past the history limit carries the cleanup hint (S7V-050)", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        fixture.cleanup = { versions: 62, bytes: 18 * 1024 * 1024 };
        const hint = cleanupHint(fixture.cleanup);
        expect(hint).toBe(
          "Cleanup due: 62 saved versions (18.0 MB). Once, end your reply asking if the user wants to keep only the last 20 or remove all old versions; they choose in the Editor panel.",
        );
        const imported = yield* call(threadA, "video_import", { path: fixture.sharedInA });
        expect(imported.structuredContent).toEqual({ media: "shared-sound", cleanup: hint });
        const cut = yield* call(threadA, "video_remove_silences", {});
        expect(cut.structuredContent).toMatchObject({ changed: true, cleanup: hint });
        // Reads never carry it.
        const read = yield* call(threadA, "video_edit_read", {});
        expect(read.structuredContent).not.toHaveProperty("cleanup");
        fixture.cleanup = undefined;
        const below = yield* call(threadA, "video_remove_silences", {});
        expect(below.structuredContent).not.toHaveProperty("cleanup");
      }),
    ),
  );

  it.effect("video_import refuses to copy when the disk is short", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        fixture.diskShort = true;
        const result = yield* call(threadA, "video_import", { path: fixture.sharedInA });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toEqual([NO_ROOM_TO_COPY]);
        expect(fixture.imports).toEqual([]);
        expect(fixture.silences).toEqual([]);
      }),
    ),
  );

  it.effect("video_import refuses an arbitrary path and other threads' files", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        for (const path of [
          NodePath.join(fixture.outside, "secret.mp4"),
          NodePath.join(fixture.outside, "nothing-here.mp4"),
          fixture.sharedInB,
          NodePath.basename(fixture.sharedInA),
          // A symlink inside the project that leads outside it.
          NodePath.join(fixture.rootA, "assets", "link.mp4"),
        ]) {
          const result = yield* call(threadA, "video_import", { path });
          expect(result.isError, path).toBe(true);
          expect(textOf(result), path).toEqual([NOT_SHARED]);
        }
        expect(fixture.imports).toEqual([]);
      }),
    ),
  );

  it.effect("video_probe calls EngineService.probe once with the media's real path", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const byId = yield* call(threadA, "video_probe", { media: "cam" });
        expect(byId.isError).toBe(false);
        expect(byId.structuredContent).toMatchObject({
          media: "cam",
          path: "cam",
          video: { width: 1280, height: 720 },
        });
        expect(fixture.calls).toEqual([["probe", NodePath.join(fixture.rootA, "assets/clip.mp4")]]);

        const byPath = yield* call(threadA, "video_probe", { media: "assets/clip.mp4" });
        expect(byPath.structuredContent).toMatchObject({ media: "assets/clip.mp4" });
        const absolute = yield* call(threadA, "video_probe", {
          media: NodePath.join(fixture.rootA, "assets", "clip.mp4"),
        });
        expect(absolute.isError).toBe(false);
        const reference = yield* call(threadA, "video_probe", { media: "ref" });
        expect(reference.isError).toBe(false);
        // A recorded reference is accepted by its path too, not only by its id.
        const referencePath = yield* call(threadA, "video_probe", {
          media: NodePath.join(fixture.outside, "imported.mov"),
        });
        expect(referencePath.isError).toBe(false);
        expect(fixture.calls.map(([, path]) => path)).toEqual([
          NodePath.join(fixture.rootA, "assets/clip.mp4"),
          NodePath.join(fixture.rootA, "assets/clip.mp4"),
          NodePath.join(fixture.rootA, "assets/clip.mp4"),
          NodePath.join(fixture.outside, "imported.mov"),
          NodePath.join(fixture.outside, "imported.mov"),
        ]);
      }),
    ),
  );

  describe("refuses media outside the caller's project without calling the engine", () => {
    const refused = (media: (fixture: Fixture) => string, threadId = threadA) =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          for (const tool of [
            "video_probe",
            "video_frame",
            "video_transcribe",
            "video_transcript_read",
          ]) {
            const args =
              tool === "video_frame"
                ? { media: media(fixture), frame: 0 }
                : { media: media(fixture) };
            const result = yield* call(threadId, tool, args);
            expect(result.isError, tool).toBe(true);
            expect(textOf(result), tool).toEqual([NOT_IN_PROJECT]);
          }
          expect(fixture.calls).toEqual([]);
          expect(fixture.started).toEqual([]);
        }),
      );

    it.effect("should refuse a path outside the project", () =>
      refused((fixture) => NodePath.join(fixture.outside, "secret.mp4")),
    );
    it.effect("should refuse a missing file outside the project without saying it is missing", () =>
      refused((fixture) => NodePath.join(fixture.outside, "nothing-here.mp4")),
    );
    it.effect("should refuse a symlink that escapes the project", () =>
      refused(() => "assets/link.mp4"),
    );
    it.effect("should refuse a file reached through a symlinked folder", () =>
      refused(() => "assets/desktop/secret.mp4"),
    );
    it.effect("should refuse a missing file behind a symlinked folder the same way", () =>
      refused(() => "assets/desktop/nothing-here.mp4"),
    );
    it.effect("should refuse a dangling symlink that points outside the project", () =>
      refused(() => "assets/dangling.mp4"),
    );
    it.effect("should refuse a chain of symlinks that ends outside the project", () =>
      refused(() => "assets/chained.mp4"),
    );
    it.effect("should refuse a relative dangling symlink behind a symlinked folder", () =>
      refused(() => "assets/desktop/rel-link.mp4"),
    );
    it.effect("still says a dangling symlink inside the project is missing", () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          const result = yield* call(threadA, "video_probe", {
            media: "assets/dangling-inside.mp4",
          });
          expect(textOf(result)).toEqual([
            "There is no file at assets/dangling-inside.mp4 in this project.",
          ]);
          expect(fixture.calls).toEqual([]);
        }),
      ),
    );
    it.effect("should refuse a missing recorded path outside the project the same way", () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          fixture.documents.set(
            projectA,
            documentWith([media({ id: "gone", path: "assets/desktop/gone.mp4" })]),
          );
          const result = yield* call(threadA, "video_probe", { media: "gone" });
          expect(textOf(result)).toEqual([NOT_IN_PROJECT]);
          expect(fixture.calls).toEqual([]);
        }),
      ),
    );
    it.effect("still says a missing file inside the project is missing", () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          const result = yield* call(threadA, "video_probe", { media: "assets/none/x.mp4" });
          expect(textOf(result)).toEqual([
            "There is no file at assets/none/x.mp4 in this project.",
          ]);
          expect(fixture.calls).toEqual([]);
        }),
      ),
    );
    it.effect("should refuse ../ traversal", () =>
      refused(() => "assets/../../Desktop/secret.mp4"),
    );
    it.effect("should refuse a recorded media path that climbs out of the project", () =>
      refused(() => "escape"),
    );
    it.effect("should refuse a recorded media path that is a symlink out of the project", () =>
      refused(() => "linked"),
    );
    it.effect("should refuse another project's media and files", () =>
      refused((fixture) => NodePath.join(fixture.rootB, "assets", "other.mp4")),
    );
    it.effect("should refuse another project's media id", () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          // Not an id here, so it is read as a project path, which does not exist.
          const result = yield* call(threadA, "video_probe", { media: "other" });
          expect(textOf(result)).toEqual(["There is no file at other in this project."]);
          expect(fixture.calls).toEqual([]);
        }),
      ),
    );
  });

  it.effect(
    "video_transcribe starts a job for the caller's project, or says the model is missing",
    () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          const started = yield* call(threadA, "video_transcribe", { media: "cam" });
          expect(started.isError).toBe(false);
          expect(started.structuredContent).toEqual({ jobId: "engine-job-9" });
          // Tagged with the caller's project, so video_job_status and video_job_cancel see it.
          expect(fixture.started).toEqual([{ kind: "transcribe", projectId: projectA }]);

          fixture.engine.modelsReady = false;
          const missing = yield* call(threadA, "video_transcribe", { media: "cam" });
          expect(missing.isError).toBe(true);
          expect(textOf(missing)).toEqual([
            "The speech model isn't downloaded yet. Ask the user to press Download speech model at the top of the Editor panel; s7video downloads it only after they agree.",
          ]);
          expect(fixture.started).toHaveLength(1);
        }),
      ),
  );

  it.effect("video_transcribe refuses a read-only client; video_transcript_read does not", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const readOnly = { sessionId: "session-ro", label: "Viewer", access: "read-only" as const };
        const refused = yield* call(
          threadA,
          "video_transcribe",
          { media: "cam" },
          undefined,
          readOnly,
        );
        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toEqual([
          "This tool changes the environment, and this MCP client was approved for read-only access.",
        ]);
        expect(fixture.started).toEqual([]);
        // Reading stays open to read-only clients: it gets the normal "not transcribed" answer.
        const read = yield* call(
          threadA,
          "video_transcript_read",
          { media: "cam" },
          undefined,
          readOnly,
        );
        expect(textOf(read)).toEqual(["cam has no transcript yet. Run video_transcribe first."]);
      }),
    ),
  );

  // S7V-070: listing versions is a read; making one main changes the edit.
  it.effect("video_version_restore refuses a read-only client; video_versions does not", () =>
    withTools(({ call }) =>
      Effect.gen(function* () {
        const readOnly = { sessionId: "session-ro", label: "Viewer", access: "read-only" as const };
        const refused = yield* call(
          threadA,
          "video_version_restore",
          { version: "v1" },
          undefined,
          readOnly,
        );
        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toEqual([
          "This tool changes the environment, and this MCP client was approved for read-only access.",
        ]);
        const listed = yield* call(threadA, "video_versions", {}, undefined, readOnly);
        expect(listed.structuredContent).toEqual({ versions: [] });
      }),
    ),
  );

  it.effect("video_remove_silences cuts the caller's project and reports the result", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const result = yield* call(threadA, "video_remove_silences", {
          minGapSeconds: 0.8,
          keep: "30-60, 90-120",
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ removedSeconds: 3.2, cuts: 4 });
        expect(fixture.silences).toEqual([
          {
            projectId: projectA,
            minGapSeconds: 0.8,
            keep: [
              { fromFrame: 30, toFrame: 60 },
              { fromFrame: 90, toFrame: 120 },
            ],
            // S7V-069: the reply calling the tool, so its changes make one version.
            reply: { threadId: threadA, runId: "run:mcp-test" },
          },
        ]);
        for (const [keep, reason] of [
          ["after hello", KEEP_FORMAT],
          ["60-30", KEEP_FORMAT],
          ["30-30", KEEP_FORMAT],
          ["30-60,", KEEP_FORMAT],
          ["30-60,,90-120", KEEP_FORMAT],
          ["-5-10", KEEP_FORMAT],
          ["30-60, 50-80", KEEP_OVERLAP],
          ["90-120,10-95", KEEP_OVERLAP],
        ] as const) {
          const refused = yield* call(threadA, "video_remove_silences", { keep });
          expect(textOf(refused), keep).toEqual([reason]);
        }
        // Spaces are fine, and ranges may come in any order.
        yield* call(threadA, "video_remove_silences", { keep: " 90 - 120 ,30-60 " });
        expect(fixture.silences.at(-1)?.keep).toEqual([
          { fromFrame: 30, toFrame: 60 },
          { fromFrame: 90, toFrame: 120 },
        ]);

        const refused = yield* call(threadA, "video_remove_silences", { media: "silent" });
        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toEqual(["silent has no speech in its transcript."]);

        const readOnly = { sessionId: "session-ro", label: "Viewer", access: "read-only" as const };
        const blocked = yield* call(threadA, "video_remove_silences", {}, undefined, readOnly);
        expect(blocked.isError).toBe(true);
        expect(fixture.silences).toHaveLength(3);
      }),
    ),
  );

  it.effect("video_transcript_read returns frame-stamped text, or asks for video_transcribe", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const none = yield* call(threadA, "video_transcript_read", { media: "cam" });
        expect(none.isError).toBe(true);
        expect(textOf(none)).toEqual(["cam has no transcript yet. Run video_transcribe first."]);

        const clip = NodePath.join(fixture.rootA, "assets", "clip.mp4");
        const bytes = NodeFS.readFileSync(clip);
        const fingerprint = {
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        };
        const cacheDir = NodePath.join(fixture.rootA, ".s7cache", "transcripts");
        NodeFS.mkdirSync(cacheDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(cacheDir, `${fingerprint.sha256}.json`),
          JSON.stringify({
            transcriptVersion: 1,
            mediaFingerprint: fingerprint,
            model: "m",
            revision: "r",
            fps: { num: 30, den: 1 },
            durationFrames: 90,
            words: [
              { text: "Hello", startFrame: 3, endFrame: 12, confidence: 0.9, speaker: "S1" },
              { text: "world.", startFrame: 13, endFrame: 25, confidence: 0.8, speaker: "S1" },
            ],
            createdAt: "2026-11-06T00:00:00Z",
          }),
        );
        const read = yield* call(threadA, "video_transcript_read", { media: "assets/clip.mp4" });
        expect(read.structuredContent).toEqual({
          text: "fps 30/1; [start-end] are frames of the clip.\n[3-25] Hello world.",
        });
        // A cached clip needs no job.
        const cached = yield* call(threadA, "video_transcribe", { media: "cam" });
        expect(cached.structuredContent).toEqual({
          cached: true,
          wordCount: 2,
          durationFrames: 90,
        });
        expect(fixture.started).toEqual([]);
        // Thread B's project cannot read project A's transcript.
        const other = yield* call(threadB, "video_transcript_read", { media: clip });
        expect(textOf(other)).toEqual([NOT_IN_PROJECT]);
      }),
    ),
  );

  it.effect("should refuse every video tool without the video capability", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        for (const [tool, args] of [
          ["video_probe", { media: "cam" }],
          ["video_frame", { media: "cam", frame: 0 }],
          ["video_edit_read", {}],
          ["video_job_status", {}],
          ["video_job_cancel", { jobId: "engine-job-1" }],
          ["video_export", {}],
          ["video_canvas", { ratio: "16:9" }],
          ["video_transcribe", { media: "cam" }],
          ["video_transcript_read", { media: "cam" }],
          ["video_import", { path: "/tmp/x.mp4" }],
          ["video_undo", {}],
          ["video_redo", {}],
          ["video_remove_silences", {}],
          ["video_assemble", { items: [] }],
          ["video_add_captions", {}],
          ["video_place_audio", { media: "cam" }],
          ["video_duck_music", {}],
          ["video_versions", {}],
          ["video_version_restore", { version: "v1" }],
        ] as const) {
          // A hidden tool is not callable at all: the server answers as for an unknown tool.
          const error = yield* call(threadA, tool, args, ["orchestration"]).pipe(Effect.flip);
          expect(String(error), tool).toContain(`Tool '${tool}' not found`);
        }
        expect(fixture.calls).toEqual([]);
        expect(fixture.cancelled).toEqual([]);
        expect(fixture.exports).toEqual([]);
        expect(fixture.imports).toEqual([]);
        expect(fixture.sounds).toEqual([]);
      }),
    ),
  );

  // S7V-036: one service call for the caller's own project; its plain refusals reach the agent.
  it.effect("video_place_audio places through the service and offers undo", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const placed = yield* call(threadA, "video_place_audio", {
          media: "cam",
          at: 40,
          track: "sfx",
        });
        expect(placed.isError).toBe(false);
        expect(placed.structuredContent).toEqual({
          revision: 10,
          item: { id: "sfx1", trackId: "S1", start: 42, duration: 5, gainDb: -5.3 },
          message:
            'Added "whoosh" on the sound effect track at 1.8 s, 9 dB under the voice. Say undo to take it out.',
        });
        expect(fixture.sounds).toEqual([
          [
            "place",
            projectA,
            { media: "cam", at: 40, clip: undefined, track: "sfx", gainDb: undefined },
          ],
        ]);
        const refused = yield* call(threadB, "video_place_audio", { media: "other", at: 40 });
        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toEqual([
          "Frame 40 of other was cut from the edit, so nothing was added.",
        ]);
      }),
    ),
  );

  it.effect("video_place_audio refuses media outside the project before the service", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        for (const args of [
          { media: NodePath.join(fixture.outside, "secret.mp4") },
          { media: "cam", clip: "escape" },
          { media: "linked" },
        ]) {
          const refused = yield* call(threadA, "video_place_audio", args);
          expect(refused.isError, JSON.stringify(args)).toBe(true);
        }
        expect(fixture.sounds).toEqual([]);
      }),
    ),
  );

  it.effect("video_duck_music ducks through the service and says when there is no music", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const ducked = yield* call(threadA, "video_duck_music", {});
        expect(ducked.structuredContent).toEqual({
          revision: 11,
          ranges: 13,
          message: "The music now dips 12 dB under speech in 13 places. Say undo to take it out.",
        });
        const refused = yield* call(threadB, "video_duck_music", { depthDb: -9 });
        expect(textOf(refused)).toEqual([
          "There is no music in the edit yet. Place it with video_place_audio first.",
        ]);
        expect(fixture.sounds).toEqual([
          ["duck", projectA, { depthDb: undefined }],
          ["duck", projectB, { depthDb: -9 }],
        ]);
      }),
    ),
  );

  it.effect(
    "video_add_captions answers with the count, and refuses a clip with no transcript",
    () =>
      withTools(({ call }) =>
        Effect.gen(function* () {
          const added = yield* call(threadA, "video_add_captions", {});
          expect(added.isError).toBe(false);
          expect(added.structuredContent).toEqual({
            revision: 9,
            message:
              "Added 12 captions to the edit. They follow later cuts; say undo to remove them.",
          });
          const refused = yield* call(threadB, "video_add_captions", {});
          expect(refused.isError).toBe(true);
          expect(textOf(refused)).toEqual(["Transcribe the clip first: cam has no transcript."]);
        }),
      ),
  );

  it.effect(
    "video_frame returns one PNG at the media's recorded rate, 640 px wide by default",
    () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          const result = yield* call(threadA, "video_frame", { media: "cam", frame: 150 });
          expect(result.isError).toBe(false);
          expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
          expect(result.structuredContent).toEqual({
            media: "cam",
            frame: 150,
            rate: { num: 30, den: 1 },
            screenshot: { mimeType: "image/png", width: 640, height: 360 },
          });
          expect(fixture.calls).toEqual([
            [
              "frame",
              {
                path: NodePath.join(fixture.rootA, "assets/clip.mp4"),
                frame: 150,
                rate: { num: 30, den: 1 },
                maxWidth: 640,
              },
            ],
          ]);
          // The engine's scratch PNG is removed once its bytes are in the result.
          expect(NodeFS.existsSync(NodePath.join(fixture.outside, "frame-150.png"))).toBe(false);
        }),
      ),
  );

  it.effect("video_frame probes a path the edit has not imported for its frame rate", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const result = yield* call(threadA, "video_frame", {
          media: "assets/clip.mp4",
          frame: 10,
          maxWidth: 5000,
        });
        expect(result.isError).toBe(false);
        expect(fixture.calls.map(([kind]) => kind)).toEqual(["probe", "frame"]);
        expect(fixture.calls[1]![1]).toMatchObject({ rate: { num: 25, den: 1 }, maxWidth: 1920 });
        const negative = yield* call(threadA, "video_frame", { media: "cam", frame: -1 });
        expect(negative.isError).toBe(true);
      }),
    ),
  );

  it.effect("video_edit_read returns compact summary of a 1,000-item edit", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const items = Array.from({ length: 1_000 }, (_, index) => ({
          id: `c${index}`,
          media: "cam",
          start: index * 30,
          duration: 30,
          in: 0,
        }));
        const captions = Array.from({ length: 10 }, (_, index) => ({
          id: `t${index}`,
          start: index * 60,
          duration: 60,
          text: `caption ${index}`,
        }));
        fixture.documents.set(
          projectA,
          documentWith(
            [media({ id: "cam", path: "assets/clip.mp4", label: "Camera" })],
            [
              { kind: "video", id: "V1", items },
              { kind: "caption", id: "C1", items: captions },
            ],
          ),
        );
        const result = yield* call(threadA, "video_edit_read", {});
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({
          revision: 7,
          fps: { num: 30, den: 1 },
          canvas: { width: 1080, height: 1920 },
          durationFrames: 30_000,
          tracks: [
            { id: "V1", kind: "video", items: 1_000 },
            { id: "C1", kind: "caption", items: 10 },
          ],
          media: [{ id: "cam", kind: "video", durationFrames: 300, label: "Camera" }],
          markers: 0,
          canUndo: true,
          canRedo: false,
        });
        // Compact: the summary, not the document.
        expect(JSON.stringify(result.structuredContent).length).toBeLessThan(400);
        expect(fixture.calls).toEqual([]);
      }),
    ),
  );

  it("measures an edit's length from the end of its last item", () => {
    expect(editDurationFrames(documentWith([]))).toBe(0);
    expect(
      editDurationFrames(
        documentWith(
          [],
          [
            {
              kind: "video",
              id: "V1",
              items: [{ id: "a", media: "m", start: 0, duration: 90, in: 0 }],
            },
            { kind: "caption", id: "C1", items: [{ id: "t", start: 60, duration: 45, text: "" }] },
          ],
        ),
      ),
    ).toBe(105);
  });

  it.effect("should not show other projects' jobs", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const mine = yield* call(threadA, "video_job_status", {});
        expect(mine.structuredContent).toEqual({ jobs: [job("engine-job-1", projectA)] });
        const theirs = yield* call(threadB, "video_job_status", {});
        expect(theirs.structuredContent).toEqual({ jobs: [job("engine-job-2", projectB)] });
        const filtered = yield* call(threadA, "video_job_status", { jobId: "engine-job-2" });
        expect(filtered.structuredContent).toEqual({ jobs: [] });

        const foreign = yield* call(threadA, "video_job_cancel", { jobId: "engine-job-2" });
        expect(foreign.isError).toBe(true);
        expect(textOf(foreign)).toEqual([
          "There is no running video job with that id in this project.",
        ]);
        expect(fixture.cancelled).toEqual([]);
      }),
    ),
  );

  it.effect("video_job_status waitSeconds returns as soon as the job ends (S7V-058)", () =>
    withTools(({ call }) =>
      Effect.gen(function* () {
        const waiting = yield* call(threadA, "video_job_status", {
          jobId: "engine-job-1",
          waitSeconds: 30,
        }).pipe(Effect.forkChild);
        yield* call(threadA, "video_job_cancel", { jobId: "engine-job-1" });
        const result = yield* Fiber.join(waiting);
        expect(result.structuredContent).toEqual({
          jobs: [{ ...job("engine-job-1", projectA), state: "cancelled" }],
        });
        // A job that is not running (or not this project's) answers at once.
        const other = yield* call(threadA, "video_job_status", {
          jobId: "engine-job-2",
          waitSeconds: 30,
        });
        expect(other.structuredContent).toEqual({ jobs: [] });
      }),
    ),
  );

  it.effect("video_job_status waitSeconds gives the running job back when the wait is over", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const subscribed = yield* Deferred.make<void>();
        fixture.onSubscribe = Deferred.succeed(subscribed, undefined).pipe(Effect.asVoid);
        const waiting = yield* call(threadA, "video_job_status", {
          jobId: "engine-job-1",
          waitSeconds: 500,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        // Capped at 30 s, so a long wait cannot hold the agent's turn.
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(waiting);
        expect(result.structuredContent).toEqual({ jobs: [job("engine-job-1", projectA)] });
      }),
    ),
  );

  it.effect("video_job_status reports a job that ended between two calls (S7V-058)", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const ended = (id: string, state: "succeeded" | "failed" | "cancelled") => ({
          ...job(id, projectA),
          state,
          ...(state === "failed" ? { message: "The speech model could not load." } : {}),
        });
        fixture.recent = [
          ended("engine-job-7", "succeeded"),
          ended("engine-job-8", "cancelled"),
          ended("engine-job-9", "failed"),
          { ...job("engine-job-10", projectB), state: "succeeded" },
        ];
        // Newest first, after the running job; only the caller's project.
        const mine = yield* call(threadA, "video_job_status", {});
        expect(mine.structuredContent).toEqual({
          jobs: [
            job("engine-job-1", projectA),
            ended("engine-job-9", "failed"),
            ended("engine-job-8", "cancelled"),
            ended("engine-job-7", "succeeded"),
          ],
        });
        for (const [id, state] of [
          ["engine-job-7", "succeeded"],
          ["engine-job-8", "cancelled"],
          ["engine-job-9", "failed"],
        ] as const) {
          for (const waitSeconds of [undefined, 30]) {
            const one = yield* call(threadA, "video_job_status", {
              jobId: id,
              ...(waitSeconds === undefined ? {} : { waitSeconds }),
            });
            expect(one.structuredContent).toEqual({ jobs: [ended(id, state)] });
          }
        }
        // Another project's finished job stays hidden, waiting or not.
        const foreign = yield* call(threadA, "video_job_status", {
          jobId: "engine-job-10",
          waitSeconds: 30,
        });
        expect(foreign.structuredContent).toEqual({ jobs: [] });
        const theirs = yield* call(threadB, "video_job_status", {});
        expect(theirs.structuredContent).toEqual({
          jobs: [
            job("engine-job-2", projectB),
            { ...job("engine-job-10", projectB), state: "succeeded" },
          ],
        });
      }),
    ),
  );

  it.effect("video_job_cancel stops the project's job and reports its final state", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const result = yield* call(threadA, "video_job_cancel", { jobId: "engine-job-1" });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ jobId: "engine-job-1", state: "cancelled" });
        expect(fixture.cancelled).toEqual(["engine-job-1"]);
      }),
    ),
  );

  it.effect(
    "video_export starts the caller's project's export as a job it can follow and stop",
    () =>
      withTools(({ fixture, call }) =>
        Effect.gen(function* () {
          // S7V-061: no preset; the export takes the edit's canvas, which video_canvas changes.
          const started = yield* call(threadA, "video_export", {});
          expect(started.isError).toBe(false);
          expect(started.structuredContent).toEqual({
            jobId: "engine-job-export-1",
            path: "exports/my-reel-20261106-0930.mp4",
          });
          // Always the caller's own project: the tool takes no project argument.
          expect(fixture.exports).toEqual([{ projectId: projectA }]);

          const mine = yield* call(threadA, "video_job_status", { jobId: "engine-job-export-1" });
          expect(mine.structuredContent).toMatchObject({
            jobs: [{ id: "engine-job-export-1", kind: "export", projectId: projectA }],
          });
          const theirs = yield* call(threadB, "video_job_status", { jobId: "engine-job-export-1" });
          expect(theirs.structuredContent).toEqual({ jobs: [] });
          const foreign = yield* call(threadB, "video_job_cancel", {
            jobId: "engine-job-export-1",
          });
          expect(foreign.isError).toBe(true);
          expect(fixture.cancelled).toEqual([]);
          yield* call(threadA, "video_job_cancel", { jobId: "engine-job-export-1" });
          expect(fixture.cancelled).toEqual(["engine-job-export-1"]);
        }),
      ),
  );

  it.effect("should refuse video_export outside a video project", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        const plain = yield* call(threadPlain, "video_export", { captions: false });
        expect(plain.isError).toBe(true);
        expect(fixture.exports).toEqual([]);
      }),
    ),
  );

  it.effect("should return crashed then succeed on retry", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        fixture.engine.failNextProbe = true;
        const crashed = yield* call(threadA, "video_probe", { media: "cam" });
        expect(crashed.isError).toBe(true);
        expect(textOf(crashed).join(" ")).toContain(
          "The video engine stopped during media.probe. It restarts on the next call; try again.",
        );
        const retried = yield* call(threadA, "video_probe", { media: "cam" });
        expect(retried.isError).toBe(false);
        expect(fixture.calls).toHaveLength(2);
      }),
    ),
  );
});

it.effect("should hide tools without the video capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tokens = new Map([
        ["videoToken", scopeFor(threadA)],
        ["plainToken", scopeFor(threadPlain, ["orchestration", "worktree", "pull-requests"])],
      ]);
      const fixture = makeFixture();
      const cancelSignal = yield* Deferred.make<string>();
      const settingsContext = yield* Layer.build(ServerSettings.layerTest());
      const serverLayer = McpHttpServer.layerVideoToolkit.pipe(
        Layer.provideMerge(
          McpHttpServer.layerMcpTransport.pipe(
            Layer.provide(Layer.succeedContext(settingsContext)),
          ),
        ),
        Layer.provide(layerFor(fixture, cancelSignal)),
        Layer.provide(Layer.mock(TranscriptService.TranscriptService)({})),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "video-tools-list-" })),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) => Effect.succeed(tokens.get(presented)),
          }),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const listed = (token: string) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const response = yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
              "application/json",
            ),
          });
          const body = (yield* response.json) as {
            result: { tools: ReadonlyArray<{ name: string }> };
          };
          return body.result.tools.map((tool) => tool.name).toSorted();
        });

      expect(yield* listed("videoToken")).toEqual([
        "video_add_captions",
        "video_assemble",
        "video_canvas",
        "video_duck_music",
        "video_edit_read",
        "video_export",
        "video_frame",
        "video_import",
        "video_job_cancel",
        "video_job_status",
        "video_place_audio",
        "video_probe",
        "video_redo",
        "video_remove_silences",
        "video_transcribe",
        "video_transcript_read",
        "video_undo",
        "video_version_restore",
        "video_versions",
      ]);
      expect(yield* listed("plainToken")).toEqual([]);
      NodeFS.rmSync(NodePath.dirname(fixture.rootA), { recursive: true, force: true });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// Any tool added to the toolkit later must carry the same visibility check.
it("marks every video tool with the video EnabledWhen check", () => {
  for (const tool of Object.values(VideoToolkit.tools)) {
    expect(Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen), tool.name).toBe(
      McpInvocationContext.hiddenWithoutVideo,
    );
  }
});
