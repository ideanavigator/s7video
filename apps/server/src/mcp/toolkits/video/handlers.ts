// S7V-020 A3 spike. Throwaway.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as EngineService from "../../../videoEngine/EngineService.ts";
import { VideoFrameToolkit, VideoProbeToolkit } from "./tools.ts";

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "EngineError" && (error as EngineService.EngineError).reason === "rpc_error"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

const requireVideo = McpInvocationContext.requireMcpCapability("video").pipe(
  Effect.mapError(toFailure),
);

// biome-ignore lint: spike trusts the engine shape
type ProbeResult = any;

const handlers = {
  video_probe: McpToolAccess.reads((input: { readonly path: string }) =>
    Effect.gen(function* () {
      yield* requireVideo;
      const engine = yield* EngineService.EngineService;
      return (yield* engine
        .call("probe", { path: input.path })
        .pipe(Effect.mapError(toFailure))) as ProbeResult;
    }),
  ),
  video_frame: McpToolAccess.reads(
    (input: { readonly path: string; readonly t: number; readonly width?: number | undefined }) =>
      Effect.gen(function* () {
        yield* requireVideo;
        const engine = yield* EngineService.EngineService;
        const frame = (yield* engine.call("frame", input).pipe(Effect.mapError(toFailure))) as {
          path: string;
          t: number;
          width: number;
          height: number;
          data: string;
        };
        return {
          path: frame.path,
          t: frame.t,
          screenshot: {
            mimeType: "image/png" as const,
            data: frame.data,
            width: frame.width,
            height: frame.height,
          },
        };
      }),
  ),
};

export const layerProbe = McpToolAccess.toLayer(VideoProbeToolkit, {
  video_probe: handlers.video_probe,
});

export const layerFrame = McpToolAccess.toLayer(VideoFrameToolkit, {
  video_frame: handlers.video_frame,
});
