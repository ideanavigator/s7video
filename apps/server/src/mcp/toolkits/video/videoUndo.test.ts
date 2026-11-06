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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
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

/** The real edit services over git in a temp home, behind the video toolkit. */
const withProject = <A, E>(
  body: (input: {
    readonly root: string;
    readonly thread: Thread;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly call: (
      name: string,
    ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-undo-" });
    const thread: Thread = {
      projectId: "" as ProjectId,
      interactionMode: "default",
      capabilities: ["orchestration", "video"],
    };
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
      Layer.mock(EngineService.EngineService)({}),
      Layer.mock(ExportService.ExportService)({}),
      Layer.mock(MediaLibraryService.MediaLibraryService)({}),
      Layer.mock(TranscriptService.TranscriptService)({}),
      Layer.mock(SilenceCutService.SilenceCutService)({}),
    ).pipe(Layer.provideMerge(layerEditTest(baseDir)));
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const server = yield* McpServer.McpServer;
      const created = yield* folders.createNamedProject({ name: "Undo test" });
      thread.projectId = created.projectId;
      const call = (name: string) =>
        server
          .callTool({ name, arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(thread)),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      return yield* body({ root: created.workspaceRoot, thread, edits, call });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerVideoToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(services),
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

  it.effect("should refuse in a plan-mode thread and change nothing", () =>
    withProject(({ root, thread, edits, call }) =>
      Effect.gen(function* () {
        const initial = yield* edits.read(thread.projectId);
        yield* edits.apply(thread.projectId, setup, {
          origin: "agent",
          baseRevision: initial.revision,
        });
        const before = readFile(root, "edit.json");
        thread.interactionMode = "plan";
        for (const tool of ["video_undo", "video_redo"]) {
          const result = yield* call(tool);
          expect(result.isError, tool).toBe(true);
          expect(textOf(result).join(""), tool).toContain(
            "This thread is in plan mode, so it cannot change the edit.",
          );
        }
        expect(readFile(root, "edit.json")).toBe(before);
      }),
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
