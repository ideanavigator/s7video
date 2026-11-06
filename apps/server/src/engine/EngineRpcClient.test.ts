// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "@effect/vitest";
import { EngineError, MediaProbeResult, type EngineProgressParams } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EngineRpcClient from "./EngineRpcClient.ts";

const Pong = Schema.Struct({ pong: Schema.Literal(true) });

const setup = Effect.gen(function* () {
  const lines = yield* Queue.unbounded<string, Cause.Done>();
  const sent = yield* Queue.unbounded<string>();
  const progress: EngineProgressParams[] = [];
  const client = yield* EngineRpcClient.make({
    lines: Stream.fromQueue(lines),
    send: (line) => Queue.offer(sent, line).pipe(Effect.asVoid),
    onProgress: (event) => Effect.sync(() => progress.push(event)),
  });
  const reply = (body: Record<string, unknown>) =>
    Queue.take(sent).pipe(
      Effect.flatMap((line) => {
        const request = JSON.parse(line) as { id: number };
        return Queue.offer(lines, JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }));
      }),
    );
  yield* Queue.offer(
    lines,
    '{"jsonrpc":"2.0","method":"ready","params":{"version":"0","protocol":1}}',
  );
  yield* client.ready;
  return { client, lines, sent, progress, reply };
});

describe("EngineRpcClient", () => {
  it.effect("EngineRpcClient decodes responses and errors", () =>
    Effect.gen(function* () {
      const { client, reply, lines, progress } = yield* setup;

      const ok = yield* client.call("engine.ping", {}, Pong, undefined).pipe(Effect.forkChild);
      yield* reply({ result: { pong: true } });
      expect(yield* Fiber.join(ok)).toEqual({ pong: true });

      const rejected = yield* client
        .call("media.probe", { path: "/x" }, MediaProbeResult, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* reply({ error: { code: 1001, message: "file not found" } });
      const error = yield* Fiber.join(rejected);
      expect(error).toBeInstanceOf(EngineError);
      expect(error).toMatchObject({ reason: "rpc_error", rpcCode: 1001 });
      expect(error.message).toBe("The video engine rejected media.probe: file not found.");

      const wrongShape = yield* client
        .call("engine.ping", {}, Pong, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* reply({ result: { pong: "yes", seconds: 1.5 } });
      expect(yield* Fiber.join(wrongShape)).toMatchObject({
        reason: "rpc_error",
        rpcMessage: "the reply did not match its schema",
      });

      const missing = yield* client
        .call("media.frame", {}, Pong, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* reply({ error: { code: 1004, message: "x", data: { tool: "ffprobe" } } });
      expect(yield* Fiber.join(missing)).toMatchObject({ reason: "missing_tool", tool: "ffprobe" });

      const noLibass = yield* client
        .call("export.render", {}, Pong, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* reply({
        error: { code: 1004, message: "x", data: { tool: "ffmpeg", feature: "libass" } },
      });
      const libassError = yield* Fiber.join(noLibass);
      expect(libassError).toMatchObject({
        reason: "missing_tool",
        tool: "ffmpeg",
        feature: "libass",
      });
      expect(libassError.message).toContain("libass");
      const noModel = yield* client
        .call("transcribe.run", {}, Pong, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* reply({
        error: { code: 1006, message: "not downloaded", data: { profile: "default" } },
      });
      const noModelError = yield* Fiber.join(noModel);
      expect(noModelError).toMatchObject({ reason: "models_missing" });
      // Agents get this text: a plain request to accept the download, no stack trace.
      expect(noModelError.message).toBe(
        "The speech model isn't downloaded yet. Ask the user to press Download speech model at the top of the Editor panel; s7video downloads it only after they agree.",
      );

      const cancelled = yield* client
        .call("test.slowJob", {}, Pong, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Queue.offer(
        lines,
        '{"jsonrpc":"2.0","method":"progress","params":{"jobId":"j","progress":0.5,"stage":null}}',
      );
      yield* Queue.offer(lines, "garbage that is not json");
      yield* reply({ error: { code: 1003, message: "cancelled" } });
      expect(yield* Fiber.join(cancelled)).toMatchObject({ reason: "cancelled" });
      expect(progress).toEqual([{ jobId: "j", progress: 0.5, stage: null }]);
      expect(client.isOpen()).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("should fail in-flight calls with crashed when stdout closes", () =>
    Effect.gen(function* () {
      const { client, lines, sent } = yield* setup;
      const inFlight = yield* client
        .call("media.frame", {}, Pong, undefined)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Queue.take(sent);
      yield* Queue.end(lines);
      const error = yield* Fiber.join(inFlight);
      expect(error.reason).toBe("crashed");
      expect(error.message).toBe(
        "The video engine stopped during media.frame. It restarts on the next call; try again.",
      );
      yield* client.closed;
      expect(client.isOpen()).toBe(false);
      expect(
        (yield* client.call("engine.ping", {}, Pong, undefined).pipe(Effect.flip)).reason,
      ).toBe("crashed");
    }).pipe(Effect.scoped),
  );
});
