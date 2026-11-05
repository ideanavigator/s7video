// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ENGINE_RESPONSE_SCHEMAS,
  EngineError,
  EngineProgressParams,
  MediaProbeResult,
} from "./engine.ts";

/** Every path in a JSON Schema whose type is a non-integer number. */
function floatPaths(node: unknown, path = "$"): string[] {
  if (Array.isArray(node))
    return node.flatMap((item, index) => floatPaths(item, `${path}[${index}]`));
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own = record.type === "number" ? [path] : [];
  return [
    ...own,
    ...Object.entries(record).flatMap(([key, value]) => floatPaths(value, `${path}.${key}`)),
  ];
}

describe("engine contracts", () => {
  it("no float seconds appear in any engine response schema", () => {
    // Progress (0..1) is a notification, not media time; it proves the check sees floats.
    expect(floatPaths(Schema.toJsonSchemaDocument(EngineProgressParams))).not.toEqual([]);
    for (const [method, schema] of Object.entries(ENGINE_RESPONSE_SCHEMAS)) {
      expect({ method, floats: floatPaths(Schema.toJsonSchemaDocument(schema)) }).toEqual({
        method,
        floats: [],
      });
    }
  });

  it("media.probe carries frame rate as {num, den} and duration as integer frames", () => {
    const decode = Schema.decodeUnknownSync(MediaProbeResult);
    const base = {
      path: "/clip.mp4",
      container: "mov,mp4",
      sizeBytes: 10,
      bitRate: null,
      durationFrames: 90,
      video: null,
      audio: null,
    };
    expect(decode(base).durationFrames).toBe(90);
    expect(() => decode({ ...base, durationFrames: 3.5 })).toThrow();
  });

  it("gives each failure reason one fixed, actionable message", () => {
    const message = (reason: EngineError["reason"], extra: Partial<EngineError> = {}) =>
      new EngineError({ reason, method: "media.frame", ...extra }).message;
    expect(message("crashed")).toBe(
      "The video engine stopped during media.frame. It restarts on the next call; try again.",
    );
    expect(message("missing_tool", { tool: "uv" })).toBe(
      "The video engine needs uv, which was not found on this Mac. For development, install it with `brew install uv`, or set S7VIDEO_UV to its full path.",
    );
    expect(message("rpc_error", { rpcMessage: "file not found" })).toBe(
      "The video engine rejected media.frame: file not found.",
    );
    expect(message("cancelled")).toContain("cancelled");
    expect(message("timeout")).toBe(
      "The video engine did not answer media.frame in time. Try again; a stuck engine restarts on its own.",
    );
    expect(message("start_failed")).toContain("Try again");
  });
});
