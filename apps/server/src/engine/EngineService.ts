// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The video engine as a service (ADR-004): one engine per server, started on first use, started
// again on the next call after it stops, and stopped only through the scope that spawned it.
// Agents (S7V-023), the Editor panel and RPC handlers all reach the engine through here.
import {
  EngineError,
  EngineJobCancelResult,
  EnginePingResult,
  MediaFrameResult,
  MediaKeyframesResult,
  MediaProbeResult,
  MediaProxyResult,
  MediaThumbnailResult,
  type EngineJobId,
  type EngineJobsEvent,
  type EngineTool,
  type MediaFrameInput,
  type MediaKeyframesInput,
  type MediaProbeInput,
  type MediaProxyInput,
  type MediaThumbnailInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as EngineJobs from "./EngineJobs.ts";
import * as EngineProcess from "./EngineProcess.ts";
import {
  engineCommandArgs,
  engineEnvironment,
  resolveEngineProjectDir,
  resolveEngineTools,
} from "./enginePaths.ts";

export interface EngineServiceOptions {
  readonly startTimeout?: Duration.Input;
  /**
   * Per-call timeout for quick methods; jobs have none and are cancelled instead. The engine
   * stops its own tools after 25 s, so a quick call normally fails with a reason before this.
   */
  readonly callTimeout?: Duration.Input;
  /** Tool paths from settings, ahead of S7VIDEO_* variables and the usual install folders. */
  readonly tools?: Partial<Record<EngineTool, string>>;
  readonly testMethods?: boolean;
  readonly signalGroup?: EngineProcess.SignalGroup;
  /** Unload the speech model after this many idle minutes (S7V-026; PO default 10). */
  readonly transcribeIdleUnloadMinutes?: number;
}

export interface EngineJobInput<A> {
  readonly kind: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly success: Schema.Decoder<A>;
  /** The project the job works for, so agent tools can scope job status and cancel to it. */
  readonly projectId?: ProjectId;
  /** Gets the job id before the engine is called, for callers that answer at once. */
  readonly onStart?: (jobId: EngineJobId) => Effect.Effect<void>;
}

export interface EngineStatus {
  readonly pid: number | undefined;
  readonly starts: number;
  readonly lastStartupMs: number | undefined;
}

export class EngineService extends Context.Service<
  EngineService,
  {
    readonly ping: Effect.Effect<EnginePingResult, EngineError>;
    readonly probe: (input: MediaProbeInput) => Effect.Effect<MediaProbeResult, EngineError>;
    /** Writes the frame as a PNG; `outputDir` defaults to the service's scratch folder. */
    readonly frame: (input: MediaFrameInput) => Effect.Effect<MediaFrameResult, EngineError>;
    /** Any quick engine method, with the quick-call timeout; for the engine's other services. */
    readonly call: <A>(
      method: string,
      params: Readonly<Record<string, unknown>>,
      success: Schema.Decoder<A>,
    ) => Effect.Effect<A, EngineError>;
    readonly thumbnail: (
      input: MediaThumbnailInput,
    ) => Effect.Effect<MediaThumbnailResult, EngineError>;
    readonly keyframes: (
      input: MediaKeyframesInput,
    ) => Effect.Effect<MediaKeyframesResult, EngineError>;
    /** A preview proxy as a `proxy` job of `projectId`. */
    readonly proxy: (
      input: MediaProxyInput &
        Pick<EngineJobInput<unknown>, "onStart"> & {
          readonly projectId: ProjectId;
        },
    ) => Effect.Effect<MediaProxyResult, EngineError>;
    /** A long engine method as a job: progress on `subscribeJobs`, stoppable with `cancelJob`. */
    readonly runJob: <A>(input: EngineJobInput<A>) => Effect.Effect<A, EngineError>;
    /**
     * Starts a job that outlives the caller (it runs in the service's scope) and returns its id at
     * once, for agent tools that hand back a job id and let the agent follow it.
     */
    readonly startJob: <A>(input: EngineJobInput<A>) => Effect.Effect<EngineJobId>;
    readonly cancelJob: (jobId: EngineJobId) => Effect.Effect<boolean>;
    readonly subscribeJobs: Stream.Stream<EngineJobsEvent>;
    readonly status: Effect.Effect<EngineStatus>;
  }
>()("t3/engine/EngineService") {}

const CALL_TIMEOUT = "30 seconds";
const START_TIMEOUT = "30 seconds";
const CANCEL_TIMEOUT = "5 seconds";
const HEALTH_TIMEOUT = "5 seconds";
const TRANSCRIBE_IDLE_UNLOAD_MINUTES = 10;

interface Running {
  readonly process: EngineProcess.EngineProcess;
  readonly scope: Scope.Closeable;
}

const make = Effect.fn("EngineService.make")(function* (options: EngineServiceOptions) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const serviceScope = yield* Effect.scope;
  const jobs = yield* EngineJobs.make;
  const startLock = yield* Semaphore.make(1);
  const scratchDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-frames-" });
  let current: Running | undefined;
  let starts = 0;
  let lastStartupMs: number | undefined;

  const stop = (running: Running) =>
    Effect.suspend(() => {
      if (current === running) current = undefined;
      return Scope.close(running.scope, Exit.void);
    });

  const stopProcess = (process: EngineProcess.EngineProcess) =>
    Effect.suspend(() => (current?.process === process ? stop(current) : Effect.void));

  const spawn = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const homeDir = yield* HostProcess.HomeDirectory;
    const tools = yield* resolveEngineTools({
      ...(options.tools ? { configured: options.tools } : {}),
      env,
      homeDir,
    });
    const projectDir = yield* resolveEngineProjectDir(env);
    // A child of the service scope: shutdown reaps an engine even while it is still starting.
    const scope = yield* Scope.fork(serviceScope);
    const startedAt = yield* Clock.currentTimeMillis;
    const running = yield* EngineProcess.start({
      uv: tools.uv,
      args: engineCommandArgs(projectDir),
      cwd: projectDir,
      env: engineEnvironment({
        tools,
        homeDir,
        modelsDir: config.engineModelsDir,
        tmpDir: env.TMPDIR,
        testMethods: options.testMethods ?? false,
        transcribeIdleUnloadSeconds:
          (options.transcribeIdleUnloadMinutes ?? TRANSCRIBE_IDLE_UNLOAD_MINUTES) * 60,
      }),
      logFile: path.join(config.engineLogsDir, "engine.log"),
      startTimeout: options.startTimeout ?? START_TIMEOUT,
      onProgress: (progress) =>
        jobs.progress(progress.jobId as EngineJobId, progress.progress, progress.stage),
      ...(options.signalGroup ? { signalGroup: options.signalGroup } : {}),
    }).pipe(
      Scope.provide(scope),
      // Runs uninterruptibly: a failed or interrupted start is reaped, a successful one is
      // recorded before anything can interrupt the caller.
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit)) return Scope.close(scope, exit);
        return Effect.sync(() => {
          current = { process: exit.value, scope };
          starts += 1;
        });
      }),
      Effect.map((process): Running => ({ process, scope })),
    );
    const { process } = running;
    lastStartupMs = (yield* Clock.currentTimeMillis) - startedAt;
    yield* Effect.logInfo("video engine started", { pid: process.pid, startupMs: lastStartupMs });
    // stdout closed: the engine is gone. Its calls have already failed; reap its group.
    yield* process.client.closed.pipe(
      Effect.andThen(Effect.logWarning("video engine exited", { pid: process.pid })),
      Effect.andThen(stopProcess(process)),
      Effect.forkIn(serviceScope),
    );
    return running;
  }).pipe(Effect.provideContext(context));

  const acquire = startLock.withPermit(
    Effect.suspend(() => {
      if (current && current.process.client.isOpen()) return Effect.succeed(current);
      return (current ? stop(current) : Effect.void).pipe(Effect.andThen(spawn));
    }),
  );

  yield* Effect.addFinalizer(() => Effect.suspend(() => (current ? stop(current) : Effect.void)));

  // A slow call (a long file) is not a hung engine: restart only when a ping gets no answer either,
  // since a restart also ends every running job.
  const stopIfHung = (running: Running) =>
    running.process.client.call("engine.ping", {}, EnginePingResult, HEALTH_TIMEOUT).pipe(
      Effect.asVoid,
      Effect.catch(() =>
        Effect.logWarning("video engine stopped answering; restarting it", {
          pid: running.process.pid,
        }).pipe(Effect.andThen(stop(running))),
      ),
    );

  // Every caller is a named operation below, and the client adds its own call span.
  const call = Effect.fnUntraced(function* <A>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    success: Schema.Decoder<A>,
    timeout: Duration.Input | undefined,
  ) {
    const running = yield* acquire;
    return yield* running.process.client
      .call(method, params, success, timeout)
      .pipe(
        Effect.tapError((error) =>
          error.reason === "timeout" ? stopIfHung(running) : Effect.void,
        ),
      );
  });

  const callTimeout = options.callTimeout ?? CALL_TIMEOUT;

  const ping = call("engine.ping", {}, EnginePingResult, callTimeout).pipe(
    Effect.withSpan("EngineService.ping"),
  );

  const probe = Effect.fn("EngineService.probe")(function* (input: MediaProbeInput) {
    return yield* call("media.probe", { path: input.path }, MediaProbeResult, callTimeout);
  });

  const frame = Effect.fn("EngineService.frame")(function* (input: MediaFrameInput) {
    return yield* call(
      "media.frame",
      {
        path: input.path,
        frame: input.frame,
        rate: input.rate,
        outputDir: input.outputDir ?? scratchDir,
        ...(input.maxWidth === undefined ? {} : { maxWidth: input.maxWidth }),
      },
      MediaFrameResult,
      callTimeout,
    );
  });

  const thumbnail = Effect.fn("EngineService.thumbnail")(function* (input: MediaThumbnailInput) {
    return yield* call("media.thumbnail", { ...input }, MediaThumbnailResult, callTimeout);
  });

  const keyframes = Effect.fn("EngineService.keyframes")(function* (input: MediaKeyframesInput) {
    return yield* call("media.keyframes", { path: input.path }, MediaKeyframesResult, callTimeout);
  });

  const cancelJob = Effect.fn("EngineService.cancelJob")(function* (jobId: EngineJobId) {
    if (!(yield* jobs.isRunning(jobId)) || !current?.process.client.isOpen()) return false;
    const result = yield* current.process.client
      .call("job.cancel", { jobId }, EngineJobCancelResult, CANCEL_TIMEOUT)
      .pipe(Effect.option);
    return result._tag === "Some" && result.value.cancelled;
  });

  const runJob = Effect.fn("EngineService.runJob")(function* <A>(input: EngineJobInput<A>) {
    yield* Effect.annotateCurrentSpan({ "engine.job.kind": input.kind });
    const jobId = yield* jobs.start(input.kind, input.projectId);
    if (input.onStart) yield* input.onStart(jobId);
    return yield* runStartedJob(jobId, input);
  });

  const startJob = Effect.fn("EngineService.startJob")(function* <A>(input: EngineJobInput<A>) {
    yield* Effect.annotateCurrentSpan({ "engine.job.kind": input.kind });
    const jobId = yield* jobs.start(input.kind, input.projectId);
    if (input.onStart) yield* input.onStart(jobId);
    // Its outcome reaches callers through the job's state on `subscribeJobs`.
    yield* runStartedJob(jobId, input).pipe(Effect.ignore, Effect.forkIn(serviceScope));
    return jobId;
  });

  const runStartedJob = <A>(jobId: EngineJobId, input: EngineJobInput<A>) =>
    call(input.method, { ...input.params, jobId }, input.success, undefined).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return jobs.finish(jobId, "succeeded");
        if (Cause.hasInterrupts(exit.cause)) {
          // The caller went away: stop the engine side too.
          return cancelJob(jobId).pipe(Effect.andThen(jobs.finish(jobId, "cancelled")));
        }
        const cancelled = exit.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && reason.error.reason === "cancelled",
        );
        return jobs.finish(jobId, cancelled ? "cancelled" : "failed");
      }),
    );

  const quickCall = <A>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    success: Schema.Decoder<A>,
  ) => call(method, params, success, callTimeout).pipe(Effect.withSpan(`EngineService.${method}`));

  const proxy = Effect.fn("EngineService.proxy")(function* (
    input: MediaProxyInput &
      Pick<EngineJobInput<unknown>, "onStart"> & {
        readonly projectId: ProjectId;
      },
  ) {
    const { projectId, onStart, ...params } = input;
    return yield* runJob({
      kind: "proxy",
      method: "media.proxy",
      params,
      success: MediaProxyResult,
      projectId,
      ...(onStart ? { onStart } : {}),
    });
  });

  return EngineService.of({
    ping,
    probe,
    frame,
    call: quickCall,
    thumbnail,
    keyframes,
    proxy,
    runJob,
    startJob,
    cancelJob,
    subscribeJobs: jobs.subscribe,
    status: Effect.sync(() => ({ pid: current?.process.pid, starts, lastStartupMs })),
  });
});

export const layerWith = (options: EngineServiceOptions) =>
  Layer.effect(EngineService, make(options));

export const layer = layerWith({});
