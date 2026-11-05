// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// One engine process: `uv run … python -m s7engine` spawned as its own process group (the
// `htmlRender/headlessChrome.ts` pattern). The PID captured at spawn is the only one ever
// signalled: closing the scope ends stdin, sends SIGTERM to that group, and the spawner escalates
// to SIGKILL after two seconds. stderr goes to the engine log and a 2 KiB tail in memory.
import type { EngineProgressParams } from "@t3tools/contracts";
import { EngineError } from "@t3tools/contracts";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EngineRpcClient from "./EngineRpcClient.ts";

const STDERR_TAIL_BYTES = 2_048;
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

export type SignalGroup = (pid: number, signal: NodeJS.Signals) => void;

export interface EngineProcessInput {
  readonly uv: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly logFile: string;
  readonly startTimeout: Duration.Input;
  readonly onProgress: (progress: EngineProgressParams) => Effect.Effect<void>;
  /** Group signalling; tests pass a recorder. */
  readonly signalGroup?: SignalGroup;
}

const openLog = Effect.fnUntraced(function* (logFile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(logFile), { recursive: true });
  const size = yield* fileSystem.stat(logFile).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
  if (size > LOG_ROTATE_BYTES) {
    yield* fileSystem.rename(logFile, `${logFile}.1`);
  }
  return yield* fileSystem.open(logFile, { flag: "a", mode: 0o600 });
});

/** Starts the engine on the caller's scope and waits for its `ready` line. */
export const start = Effect.fn("EngineProcess.start")(function* (input: EngineProcessInput) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const signalGroup = input.signalGroup ?? signalProcessGroup;
  const log = yield* openLog(input.logFile).pipe(
    Effect.mapError((cause) => new EngineError({ reason: "start_failed", method: "start", cause })),
  );
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(input.uv, input.args, {
        cwd: input.cwd,
        env: input.env,
        extendEnv: false,
        stdin: { stream: Stream.fromQueue(outgoing), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "2 seconds",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new EngineError({ reason: "start_failed", method: "start", cause }),
      ),
      // Node throws some spawn errors synchronously; `mapError` cannot catch those.
      Effect.catchDefect((cause) =>
        Effect.fail(new EngineError({ reason: "start_failed", method: "start", cause })),
      ),
    );
  const pid = Number(child.pid);
  // Runs before the spawner's own release, which waits for the group and escalates to SIGKILL.
  yield* Effect.addFinalizer(() =>
    Queue.end(outgoing).pipe(
      Effect.andThen(
        Effect.sync(() => {
          try {
            signalGroup(pid, "SIGTERM");
          } catch {
            // ESRCH: the group already exited.
          }
        }),
      ),
    ),
  );

  const startedAt = yield* DateTime.now;
  yield* log
    .writeAll(
      textEncoder.encode(`--- engine pid ${pid} started ${DateTime.formatIso(startedAt)}\n`),
    )
    .pipe(Effect.ignore);
  let stderrTail = "";
  yield* child.stderr.pipe(
    Stream.runForEach((chunk) => {
      const text = new TextDecoder().decode(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
      return log.writeAll(chunk).pipe(Effect.ignore);
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  const client = yield* EngineRpcClient.make({
    lines: child.stdout.pipe(Stream.decodeText(), Stream.splitLines),
    send: (line) => Queue.offer(outgoing, textEncoder.encode(line)).pipe(Effect.asVoid),
    onProgress: input.onProgress,
  });

  yield* client.ready.pipe(
    Effect.timeoutOrElse({
      duration: input.startTimeout,
      orElse: () => Effect.fail(new EngineError({ reason: "timeout", method: "start" })),
    }),
    Effect.tapError(() =>
      Effect.logWarning("video engine did not start; see the engine log", {
        pid,
        stderrTailChars: stderrTail.length,
      }),
    ),
  );

  return { pid, client, stderrTail: () => stderrTail };
});

export type EngineProcess = Effect.Success<ReturnType<typeof start>>;
