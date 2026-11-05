// S7V-020 A3 spike: a long-lived Python engine spoken to over newline-delimited JSON-RPC on stdio.
// Throwaway code; never merged.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics effectFnOpportunity:off
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
  reason: Schema.Literals(["start_failed", "crashed", "timeout", "rpc_error"]),
  method: Schema.String,
  code: Schema.optional(Schema.Number),
  rpcMessage: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "start_failed":
        return "The video engine could not start.";
      case "crashed":
        return `The video engine stopped during ${this.method}. It restarts on the next call; try again.`;
      case "timeout":
        return `The video engine did not answer ${this.method} in time.`;
      case "rpc_error":
        return `The video engine rejected ${this.method}: ${this.rpcMessage ?? "unknown error"}.`;
    }
  }
}

interface Running {
  readonly pid: number;
  readonly scope: Scope.Closeable;
  readonly startedAtMs: number;
  readonly startupMs: number;
  dead: boolean;
  readonly call: (method: string, params: unknown) => Effect.Effect<unknown, EngineError>;
}

export class EngineService extends Context.Service<
  EngineService,
  {
    readonly call: (method: string, params: unknown) => Effect.Effect<unknown, EngineError>;
    readonly status: Effect.Effect<{
      readonly pid: number | undefined;
      readonly startupMs: number | undefined;
      readonly restarts: number;
    }>;
  }
>()("t3/videoEngine/EngineService") {}

const CALL_TIMEOUT = "30 seconds";
const START_TIMEOUT = "30 seconds";

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Spike config: the engine lives outside the repo.
  const engineDir = process.env.S7_ENGINE_DIR ?? "";
  const uv = process.env.S7_UV ?? "uv";
  const startLock = yield* Semaphore.make(1);
  let current: Running | undefined;
  let restarts = 0;
  let starts = 0;

  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const t0 = Date.now();
    const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const child = yield* spawner
      .spawn(
        ChildProcess.make(uv, ["run", "--quiet", "--project", engineDir, "s7engine"], {
          cwd: engineDir,
          stdin: { stream: Stream.fromQueue(outgoing), endOnDone: true },
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        Scope.provide(scope),
        Effect.mapError(
          (cause) => new EngineError({ reason: "start_failed", method: "start", cause }),
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(new EngineError({ reason: "start_failed", method: "start", cause })),
        ),
      );
    // The only PID this service ever signals: the one it spawned (closing `scope` kills it).
    const pid = child.pid as unknown as number;
    // Runs before the spawn's release: end stdin so the engine exits on EOF, then the
    // spawner signals the process group of the PID it started.
    yield* Scope.addFinalizer(scope, Queue.end(outgoing));
    const pending = new Map<
      number,
      { readonly method: string; readonly reply: Deferred.Deferred<unknown, EngineError> }
    >();
    const ready = yield* Deferred.make<void, EngineError>();
    let nextId = 0;
    const running: Running = {
      pid,
      scope,
      startedAtMs: t0,
      startupMs: 0,
      dead: false,
      call: Effect.fn("EngineService.rpc")(function* (method: string, params: unknown) {
        if (running.dead) return yield* new EngineError({ reason: "crashed", method });
        const id = ++nextId;
        const reply = yield* Deferred.make<unknown, EngineError>();
        pending.set(id, { method, reply });
        yield* Queue.offer(
          outgoing,
          new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`),
        );
        return yield* Deferred.await(reply).pipe(
          Effect.timeoutOrElse({
            duration: CALL_TIMEOUT,
            orElse: () => Effect.fail(new EngineError({ reason: "timeout", method })),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      }),
    };

    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Effect.logDebug("video engine stderr", { bytes: text.length })),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (line.trim() === "") return;
          const message = JSON.parse(line) as {
            id?: number;
            method?: string;
            result?: unknown;
            error?: { code: number; message: string };
          };
          if (message.method === "ready") return yield* Deferred.succeed(ready, undefined);
          const waiter = message.id === undefined ? undefined : pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id!);
          yield* message.error
            ? Deferred.fail(
                waiter.reply,
                new EngineError({
                  reason: "rpc_error",
                  method: waiter.method,
                  code: message.error.code,
                  rpcMessage: message.error.message,
                }),
              )
            : Deferred.succeed(waiter.reply, message.result);
        }),
      ),
      Effect.ignore,
      // stdout closed: the engine is gone. Fail in-flight calls, then reap by our own PID.
      Effect.andThen(
        Effect.gen(function* () {
          running.dead = true;
          if (current === running) current = undefined;
          const waiters = [...pending.values()];
          pending.clear();
          yield* Effect.forEach(
            waiters,
            ({ method, reply }) =>
              Deferred.fail(reply, new EngineError({ reason: "crashed", method })),
            { discard: true },
          );
          yield* Deferred.fail(ready, new EngineError({ reason: "start_failed", method: "start" }));
          yield* Effect.logWarning("video engine exited", { pid });
          yield* Scope.close(scope, Exit.void).pipe(Effect.forkDetach);
        }),
      ),
      Effect.forkIn(scope),
    );

    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () => Effect.fail(new EngineError({ reason: "timeout", method: "start" })),
      }),
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    );
    (running as { startupMs: number }).startupMs = Date.now() - t0;
    starts += 1;
    if (starts > 1) restarts += 1;
    yield* Effect.logInfo("video engine started", { pid, startupMs: running.startupMs });
    return running;
  });

  const acquire = startLock.withPermit(
    Effect.suspend(() =>
      current && !current.dead
        ? Effect.succeed(current)
        : start.pipe(Effect.tap((running) => Effect.sync(() => (current = running)))),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => (current ? Scope.close(current.scope, Exit.void) : Effect.void)),
  );

  const call = Effect.fn("EngineService.call")(function* (method: string, params: unknown) {
    yield* Effect.annotateCurrentSpan({ method });
    const running = yield* acquire;
    return yield* running.call(method, params);
  });

  return EngineService.of({
    call,
    status: Effect.sync(() => ({
      pid: current?.pid,
      startupMs: current?.startupMs,
      restarts,
    })),
  });
});

export const layer = Layer.effect(EngineService, make);
