// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off -- Makes the clip and scores frames with FFmpeg and the golden harness, outside the code under test.
/**
 * Golden `video-frame-tool` (S7V-023): `video_frame` through the real handler and engine returns
 * frame 150 of a 30 fps testsrc2 clip, 640 px wide, scored with the golden harness against an
 * independent decode (SSIM ≥ 0.98, pHash ≤ 6); frame 149 must score lower.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type EditSnapshot,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../../config.ts";
import * as EditDocumentService from "../../../edit/EditDocumentService.ts";
import * as EngineService from "../../../engine/EngineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../../../../..");
const toolPath = (name: string) =>
  ["/opt/homebrew/bin", "/usr/local/bin"]
    .map((directory) => `${directory}/${name}`)
    .find((candidate) => NodeFS.existsSync(candidate));
const available = ["uv", "ffmpeg", "ffprobe"].every((name) => toolPath(name));

const FRAME = 150;
const SSIM_MIN = 0.98;
const PHASH_MAX = 6;
const SPEC = {
  name: "video-frame-tool-30",
  fps: "30/1",
  width: 1280,
  height: 720,
  audio: [{ seconds: 6, toneHz: 440 }],
};

const projectId = ProjectId.make("project-video-golden");
const threadId = ThreadId.make("thread-video-golden");

/** The clip from S7V-031's synthetic generator, cached outside the repo. */
const synthClip = () =>
  NodeChildProcess.execFileSync(
    process.execPath,
    ["fixtures/media/synth.ts", "--spec", JSON.stringify(SPEC)],
    { cwd: REPO, encoding: "utf8", env: { ...process.env, S7VIDEO_FFMPEG: toolPath("ffmpeg") } },
  ).trim();

const decodeFrame = (clip: string, frame: number, out: string) => {
  NodeChildProcess.execFileSync(toolPath("ffmpeg")!, [
    "-v",
    "error",
    "-i",
    clip,
    "-vf",
    `select=eq(n\\,${frame}),scale=640:-2`,
    "-frames:v",
    "1",
    "-y",
    out,
  ]);
  return out;
};

/** SSIM (minimum over planes) and pHash distance from the golden harness, as engine goldens use. */
const score = (reference: string, candidate: string) => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, 'tests/golden')",
    "import harness",
    "a, b = sys.argv[1], sys.argv[2]",
    "s = harness.ssim(a, b)",
    "print(json.dumps({'ssim': s.min, 'phash': harness.phash_distance(harness.phash(a), harness.phash(b))}))",
  ].join("\n");
  const output = NodeChildProcess.execFileSync(
    toolPath("uv")!,
    ["run", "--quiet", "--project", ".", "python", "-c", script, reference, candidate],
    {
      cwd: NodePath.join(REPO, "packages/engine"),
      encoding: "utf8",
      env: { ...process.env, S7_FFMPEG: toolPath("ffmpeg"), S7_FFPROBE: toolPath("ffprobe") },
    },
  );
  return JSON.parse(output.trim().split("\n").at(-1)!) as { ssim: number; phash: number };
};

const pngWidth = (png: Buffer) => png.readUInt32BE(16);

describe.skipIf(!available)("video-frame-tool golden", () => {
  it.live(`video_frame returns frame ${FRAME} of a 30 fps clip, 640 px wide`, () =>
    Effect.gen(function* () {
      const work = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-frame-golden-")),
      );
      const root = NodePath.join(work, "Golden project");
      NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
      // A copy, not a link: a symlink out of the project is refused by design.
      NodeFS.copyFileSync(synthClip(), NodePath.join(root, "assets", "synth.mp4"));
      const snapshot: EditSnapshot = {
        revision: 1,
        canUndo: false,
        canRedo: false,
        document: {
          version: 1,
          fps: { num: 30, den: 1 },
          canvas: { width: 1080, height: 1920 },
          media: [
            {
              id: "synth",
              kind: "video",
              path: "assets/synth.mp4",
              fingerprint: { sha256: "cd".repeat(32), size: 1 },
              probe: { hasVideo: true, hasAudio: true, fps: { num: 30, den: 1 } },
            },
          ],
          tracks: [],
          markers: [],
          metadata: {},
        },
      };
      const tools = McpHttpServer.layerVideoToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed({ ...McpToolAccessTestkit.liveThreadShell(id), projectId }),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeed(Option.some({ workspaceRoot: root } as never)),
            }),
            Layer.mock(EditDocumentService.EditDocumentService)({
              read: () => Effect.succeed(snapshot),
            }),
            EngineService.layer.pipe(
              Layer.provide(ServerConfig.layerTest(work, { prefix: "video-frame-golden-" })),
            ),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );
      const result = yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        return yield* server.callTool({
          name: "video_frame",
          arguments: { media: "synth", frame: FRAME },
        });
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment-video-golden"),
          requestNamespace: "golden",
          thread: {
            threadId,
            providerSessionId: "golden",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          },
          client: undefined,
          capabilities: new Set(["video"]),
          issuedAt: 1,
        }),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            clientCapabilities: {},
            clientInfo: { name: "golden", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "golden", version: "1.0.0" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
        Effect.provide(tools),
        Effect.scoped,
      );

      try {
        expect(result.isError).toBe(false);
        const image = result.content.find((entry) => entry.type === "image");
        expect(image).toBeDefined();
        const png = Buffer.from((image as { data: Uint8Array }).data);
        expect(pngWidth(png)).toBe(640);
        const handlerPng = NodePath.join(work, "handler.png");
        NodeFS.writeFileSync(handlerPng, png);

        const clip = NodePath.join(root, "assets", "synth.mp4");
        const exact = score(
          decodeFrame(clip, FRAME, NodePath.join(work, "decoded.png")),
          handlerPng,
        );
        expect(exact.ssim).toBeGreaterThanOrEqual(SSIM_MIN);
        expect(exact.phash).toBeLessThanOrEqual(PHASH_MAX);
        const neighbour = score(
          decodeFrame(clip, FRAME - 1, NodePath.join(work, "neighbour.png")),
          handlerPng,
        );
        expect(neighbour.ssim).toBeLessThan(exact.ssim);
        console.log(
          `video-frame-tool: frame ${FRAME} SSIM ${exact.ssim.toFixed(4)}, pHash ${exact.phash}; frame ${FRAME - 1} SSIM ${neighbour.ssim.toFixed(4)}`,
        );
      } finally {
        NodeFS.rmSync(work, { recursive: true, force: true });
      }
    }),
  );
});
