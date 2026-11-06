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
import * as Stream from "effect/Stream";
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

/** Runs once, right after the next `read` returns: a write landing between a tool's read and its step. */
interface ReadHook {
  afterRead: Effect.Effect<void> | undefined;
}

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
      Layer.mock(EngineService.EngineService)({
        subscribeJobs: Stream.make({ type: "snapshot" as const, jobs: [] }),
        recentJobs: Effect.succeed([]),
      }),
      Layer.mock(ExportService.ExportService)({}),
      Layer.mock(MediaLibraryService.MediaLibraryService)({}),
      Layer.mock(TranscriptService.TranscriptService)({}),
      Layer.mock(SilenceCutService.SilenceCutService)({}),
    ).pipe(Layer.provideMerge(editLayer));
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
          ["video_canvas", { ratio: "1:1" }],
          ["video_import", { path: NodePath.join(root, "clip.mp4") }],
          ["video_transcribe", { media: "cam" }],
        ];
        for (const [tool, args] of changing) {
          const result = yield* call(tool, args);
          expect(result.isError, tool).toBe(true);
          expect(textOf(result).join(""), tool).toContain(
            "This thread is in plan mode, so it cannot change the project.",
          );
        }
        expect(readFile(root, "edit.json")).toBe(before);
        for (const tool of ["video_edit_read", "video_job_status"]) {
          expect((yield* call(tool)).isError, tool).toBe(false);
        }
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
