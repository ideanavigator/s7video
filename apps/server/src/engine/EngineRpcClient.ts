// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The server's side of the engine's newline-delimited JSON-RPC 2.0: ids, replies decoded through
// the contracts' schemas, progress notifications, per-call timeouts, and failing every call in
// flight the moment stdout closes.
import {
  ENGINE_RPC_ERROR_CODES,
  EngineError,
  EngineRpcMessage,
  EngineTool,
  EngineToolFeature,
  type EngineProgressParams,
  type EngineRpcErrorBody,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(EngineRpcMessage));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isEngineTool = Schema.is(EngineTool);
const isEngineToolFeature = Schema.is(EngineToolFeature);
const MAX_RPC_MESSAGE_CHARS = 200;

export interface EngineReady {
  readonly version: string;
  readonly protocol: number;
}

interface Pending {
  readonly method: string;
  readonly reply: Deferred.Deferred<unknown, EngineError>;
}

const errorFromRpc = (method: string, body: EngineRpcErrorBody): EngineError => {
  if (body.code === ENGINE_RPC_ERROR_CODES.cancelled) {
    return new EngineError({ reason: "cancelled", method });
  }
  if (body.code === ENGINE_RPC_ERROR_CODES.missingTool) {
    const tool = body.data?.tool;
    const feature = body.data?.feature;
    return new EngineError({
      reason: "missing_tool",
      method,
      ...(tool !== undefined && isEngineTool(tool) ? { tool } : {}),
      ...(feature !== undefined && isEngineToolFeature(feature) ? { feature } : {}),
    });
  }
  return new EngineError({
    reason: "rpc_error",
    method,
    rpcCode: body.code,
    rpcMessage: body.message.slice(0, MAX_RPC_MESSAGE_CHARS),
  });
};

/** Runs on the caller's scope: the reader stops when that scope closes. */
export const make = Effect.fn("EngineRpcClient.make")(function* <E>(input: {
  readonly lines: Stream.Stream<string, E>;
  readonly send: (line: string) => Effect.Effect<void>;
  readonly onProgress: (progress: EngineProgressParams) => Effect.Effect<void>;
}) {
  const pending = new Map<number, Pending>();
  const ready = yield* Deferred.make<EngineReady, EngineError>();
  const closed = yield* Deferred.make<void>();
  let nextId = 0;
  let open = true;

  // Per-line handling; spans per line would swamp traces, the call span covers it.
  const handleLine = Effect.fnUntraced(function* (line: string) {
    if (line.trim() === "") return;
    const decoded = decodeMessage(line);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("video engine sent an unreadable line", { chars: line.length });
      return;
    }
    const message = decoded.value;
    if ("method" in message) {
      if (message.method === "ready") {
        yield* Deferred.succeed(ready, message.params);
      } else {
        yield* input.onProgress(message.params);
      }
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    const waiter = id === undefined ? undefined : pending.get(id);
    if (id === undefined || waiter === undefined) {
      if ("error" in message) {
        yield* Effect.logWarning("video engine rejected a line", { code: message.error.code });
      }
      return;
    }
    pending.delete(id);
    yield* "error" in message
      ? Deferred.fail(waiter.reply, errorFromRpc(waiter.method, message.error))
      : Deferred.succeed(waiter.reply, message.result);
  });

  const onClose = Effect.gen(function* () {
    open = false;
    const waiters = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(
      waiters,
      ({ method, reply }) => Deferred.fail(reply, new EngineError({ reason: "crashed", method })),
      { discard: true },
    );
    yield* Deferred.fail(ready, new EngineError({ reason: "start_failed", method: "start" }));
    yield* Deferred.succeed(closed, undefined);
  });

  yield* input.lines.pipe(
    Stream.runForEach(handleLine),
    Effect.ignore,
    Effect.ensuring(onClose),
    Effect.forkScoped,
  );

  const call = Effect.fn("EngineRpcClient.call")(function* <A>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    success: Schema.Decoder<A>,
    timeout: Duration.Input | undefined,
  ) {
    yield* Effect.annotateCurrentSpan({ "engine.method": method });
    if (!open) return yield* new EngineError({ reason: "crashed", method });
    const id = ++nextId;
    const reply = yield* Deferred.make<unknown, EngineError>();
    pending.set(id, { method, reply });
    // stdout may have closed since the check above; that close cleared `pending` without us.
    if (!open) {
      pending.delete(id);
      return yield* new EngineError({ reason: "crashed", method });
    }
    yield* input.send(`${encodeRequest({ jsonrpc: "2.0", id, method, params })}\n`);
    const awaited = Deferred.await(reply);
    const result = yield* (
      timeout === undefined
        ? awaited
        : awaited.pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new EngineError({ reason: "timeout", method })),
            }),
          )
    ).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    return yield* Schema.decodeUnknownEffect(success)(result).pipe(
      Effect.mapError(
        (cause) =>
          new EngineError({
            reason: "rpc_error",
            method,
            rpcMessage: "the reply did not match its schema",
            cause,
          }),
      ),
    );
  });

  return {
    call,
    ready: Deferred.await(ready),
    closed: Deferred.await(closed),
    isOpen: () => open,
  };
});

export type EngineRpcClient = Effect.Success<ReturnType<typeof make>>;
