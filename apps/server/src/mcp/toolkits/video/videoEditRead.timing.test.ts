// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics globalConsoleInEffect:off - prints timings for the ticket.
// Timing check for S7V-023 AC-4, run by hand on a Mac:
//   S7VIDEO_VIDEO_TOOLS_TIMING=1 vp test run src/mcp/toolkits/video/videoEditRead.timing.test.ts
// It reads a real 1,000-item edit through the real EditDocumentService and the MCP tool.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import { layerEditTest } from "../../../edit/editHarness.testkit.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ExportService from "../../../export/ExportService.ts";
import * as MediaLibraryService from "../../../media/MediaLibraryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as TranscriptService from "../../../transcript/TranscriptService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const ENABLED = process.env.S7VIDEO_VIDEO_TOOLS_TIMING === "1";
const threadId = ThreadId.make("thread-video-timing");

const median = (values: ReadonlyArray<number>) =>
  values.toSorted((a, b) => a - b)[values.length >> 1]!;

describe.runIf(ENABLED)("video_edit_read timing", () => {
  it.live("AC-4: a 1,000-item edit summary in under 50 ms", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-video-timing-" });
      yield* Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const edits = yield* EditDocumentService.EditDocumentService;
        const created = yield* folders.createNamedProject({ name: "Timing" });
        const projectId: ProjectId = created.projectId;
        const initial = yield* edits.read(projectId);
        yield* edits.apply(
          projectId,
          [
            {
              _tag: "putMedia",
              media: {
                id: "cam",
                kind: "video",
                path: "assets/cam.mp4",
                fingerprint: { sha256: "ab".repeat(32), size: 4096 },
                probe: { durationFrames: 60_000, hasVideo: true, hasAudio: true },
              },
            },
            { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
            {
              _tag: "setKeepRanges",
              trackId: "V1",
              mediaId: "cam",
              ranges: Array.from({ length: 1_000 }, (_, index) => ({
                in: index * 60,
                duration: 30,
              })),
            },
          ],
          { origin: "agent", baseRevision: initial.revision },
        );

        const tools = McpHttpServer.layerVideoToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed({ ...McpToolAccessTestkit.liveThreadShell(id), projectId }),
            }),
          ),
          Layer.provide(Layer.mock(EngineService.EngineService)({})),
          Layer.provide(Layer.mock(ExportService.ExportService)({})),
          Layer.provide(Layer.mock(TranscriptService.TranscriptService)({})),
          Layer.provide(Layer.mock(MediaLibraryService.MediaLibraryService)({})),
        );
        const durations: number[] = [];
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const call = server.callTool({ name: "video_edit_read", arguments: {} }).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment-video-timing"),
              requestNamespace: "timing",
              thread: {
                threadId,
                providerSessionId: "timing",
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
              },
              client: undefined,
              capabilities: new Set(["video"] as const),
              issuedAt: 1,
            }),
            Effect.provideService(
              McpSchema.McpServerClient,
              McpSchema.McpServerClient.of({
                clientId: 1,
                clientCapabilities: {},
                clientInfo: { name: "timing", version: "1.0.0" },
                protocolVersion: "2025-06-18",
                initializePayload: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "timing", version: "1.0.0" },
                },
                getClient: Effect.die("unused"),
              }),
            ),
          );
          const first = yield* call;
          expect(first.structuredContent).toMatchObject({
            tracks: [{ id: "V1", kind: "video", items: 1_000 }],
            durationFrames: 30_000,
          });
          for (let run = 0; run < 20; run += 1) {
            const start = yield* Clock.currentTimeNanos;
            yield* call;
            durations.push(Number((yield* Clock.currentTimeNanos) - start) / 1e6);
          }
        }).pipe(Effect.provide(tools));
        console.log(
          `video_edit_read 1,000 items ms: median ${median(durations).toFixed(2)}, max ${Math.max(...durations).toFixed(2)}`,
        );
        expect(median(durations)).toBeLessThan(50);
      }).pipe(Effect.provide(layerEditTest(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
