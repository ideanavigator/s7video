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
  EngineError,
  type EngineJob,
  EngineJobId,
  type EngineJobsEvent,
  EnvironmentId,
  type MediaFrameInput,
  type MediaProbeResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { NOT_IN_PROJECT } from "../../VideoProjectScope.ts";
import { editDurationFrames } from "./handlers.ts";
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
  readonly engine: { failNextProbe: boolean };
  readonly documents: Map<ProjectId, EditDocument>;
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
  NodeFS.symlinkSync(
    NodePath.join(outside, "secret.mp4"),
    NodePath.join(rootA, "assets", "link.mp4"),
  );
  NodeFS.symlinkSync(outside, NodePath.join(rootA, "assets", "desktop"));
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
    engine: { failNextProbe: false },
    documents,
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
  return Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...McpToolAccessTestkit.liveThreadShell(threadId),
          projectId: projectOf.get(threadId) ?? ProjectId.make("project:mcp-test"),
        }),
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
        } satisfies EditSnapshot),
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
      subscribeJobs: Stream.concat(
        Stream.make({ type: "snapshot", jobs } as EngineJobsEvent),
        Stream.fromEffect(Deferred.await(cancelSignal)).pipe(
          Stream.map((id): EngineJobsEvent => ({
            type: "updated",
            job: { ...jobs.find((entry) => entry.id === id)!, state: "cancelled" },
          })),
        ),
      ),
      cancelJob: (jobId) =>
        Effect.sync(() => fixture.cancelled.push(jobId)).pipe(
          Effect.andThen(Deferred.succeed(cancelSignal, jobId)),
        ),
    }),
  );
};

const withTools = <A, E>(
  body: (input: {
    readonly fixture: Fixture;
    readonly call: (
      threadId: ThreadId,
      name: string,
      args: object,
      capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
    ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
    readonly server: McpServer.McpServer["Service"];
  }) => Effect.Effect<A, E, McpServer.McpServer>,
) =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const cancelSignal = yield* Deferred.make<string>();
    const services = layerFor(fixture, cancelSignal);
    return yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        threadId: ThreadId,
        name: string,
        args: object,
        capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              scopeFor(threadId, capabilities),
            ),
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
  it.effect("video toolkit lists five tools with video_ names", () =>
    withTools(({ server }) =>
      Effect.sync(() => {
        const tools = server.tools.map(({ tool }) => tool);
        expect(tools.map((tool) => tool.name).toSorted()).toEqual([
          "video_edit_read",
          "video_frame",
          "video_job_cancel",
          "video_job_status",
          "video_probe",
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
          for (const tool of ["video_probe", "video_frame"]) {
            const result = yield* call(threadId, tool, { media: media(fixture), frame: 0 });
            expect(result.isError, tool).toBe(true);
            expect(textOf(result), tool).toEqual([NOT_IN_PROJECT]);
          }
          expect(fixture.calls).toEqual([]);
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

  it.effect("should refuse every video tool without the video capability", () =>
    withTools(({ fixture, call }) =>
      Effect.gen(function* () {
        for (const [tool, args] of [
          ["video_probe", { media: "cam" }],
          ["video_frame", { media: "cam", frame: 0 }],
          ["video_edit_read", {}],
          ["video_job_status", {}],
          ["video_job_cancel", { jobId: "engine-job-1" }],
        ] as const) {
          // A hidden tool is not callable at all: the server answers as for an unknown tool.
          const error = yield* call(threadA, tool, args, ["orchestration"]).pipe(Effect.flip);
          expect(String(error), tool).toContain(`Tool '${tool}' not found`);
        }
        expect(fixture.calls).toEqual([]);
        expect(fixture.cancelled).toEqual([]);
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
        "video_edit_read",
        "video_frame",
        "video_job_cancel",
        "video_job_status",
        "video_probe",
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
