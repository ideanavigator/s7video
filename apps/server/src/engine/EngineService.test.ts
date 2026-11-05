// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - checks for the developer's uv and FFmpeg, and probes PIDs.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import type { EngineJobId, EngineJobsEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as ServerConfig from "../config.ts";
import * as EngineService from "./EngineService.ts";
import { ENGINE_SYSTEM_PATH } from "./enginePaths.ts";

interface FakeSpawn {
  readonly pid: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
}

const encoder = new TextEncoder();

const makeFakeSpawner = Effect.gen(function* () {
  /** `ready: false` never sends `ready`; `hung: true` answers nothing, not even a ping. */
  const control = { ready: true, hung: false };
  const spawned = yield* Queue.unbounded<number>();
  const requests = yield* Queue.unbounded<string>();
  const spawns: FakeSpawn[] = [];
  const signals: Array<readonly [number, string]> = [];
  let nextPid = 4242;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert(command._tag === "StandardCommand");
      const pid = nextPid;
      nextPid += 100;
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const write = (message: unknown) =>
        Queue.offer(stdout, encoder.encode(`${JSON.stringify(message)}\n`));
      spawns.push({
        pid,
        command: command.command,
        args: command.args,
        env: command.options.env ?? {},
        stdout,
      });
      if (control.ready) {
        yield* write({ jsonrpc: "2.0", method: "ready", params: { version: "0", protocol: 1 } });
      }
      const stdin = command.options.stdin;
      assert(typeof stdin === "object" && stdin !== null && "stream" in stdin);
      const input = stdin.stream as Stream.Stream<Uint8Array>;
      yield* input.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const request = JSON.parse(line) as { id: number; method: string };
          const answer = !control.hung && request.method === "engine.ping";
          return Queue.offer(requests, request.method).pipe(
            Effect.andThen(
              answer
                ? write({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: { pong: true, protocol: 1, pid: pid + 1 },
                  })
                : Effect.void,
            ),
          );
        }),
        // stdin closed: a real engine exits, closing stdout.
        Effect.andThen(Queue.end(stdout)),
        Effect.forkScoped,
      );
      // Stands in for the Node spawner's own release, which signals the same group.
      yield* Effect.addFinalizer(() => Effect.sync(() => signals.push([pid, "spawner-release"])));
      yield* Queue.offer(spawned, pid);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.sync(() => signals.push([pid, "kill"])),
        stdin: Sink.drain,
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.make(encoder.encode("engine log line\n")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { spawner, spawns, signals, control, spawned, requests };
});

const fakeTools = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-fake-tools-" });
  for (const name of ["uv", "ffmpeg", "ffprobe"]) {
    yield* fileSystem.writeFileString(path.join(root, name), "#!/bin/sh\n");
    yield* fileSystem.chmod(path.join(root, name), 0o755);
  }
  const engineDir = path.join(root, "engine");
  yield* fileSystem.makeDirectory(engineDir);
  yield* fileSystem.writeFileString(path.join(engineDir, "pyproject.toml"), "");
  return {
    S7VIDEO_UV: path.join(root, "uv"),
    S7VIDEO_FFMPEG: path.join(root, "ffmpeg"),
    S7VIDEO_FFPROBE: path.join(root, "ffprobe"),
    S7VIDEO_ENGINE_DIR: engineDir,
    PATH: "/parent/only/bin:/usr/bin",
    TMPDIR: "/private/tmp/engine-test",
  };
});

const withFakeEngine = <A, E>(
  options: EngineService.EngineServiceOptions,
  body: (
    fake: Effect.Success<typeof makeFakeSpawner>,
  ) => Effect.Effect<
    A,
    E,
    EngineService.EngineService | ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeSpawner;
    const env = yield* fakeTools;
    const layer = EngineService.layerWith({
      ...options,
      signalGroup: (pid, signal) => fake.signals.push([pid, signal]),
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "engine-service-" })),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)),
    );
    return yield* body(fake).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, env),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("EngineService with a fake engine", () => {
  it.effect("EngineService starts lazily and reuses one process", () =>
    withFakeEngine({}, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        expect(fake.spawns).toHaveLength(0);
        expect((yield* engine.ping).pid).toBe(4243);
        expect((yield* engine.ping).pid).toBe(4243);
        expect(fake.spawns).toHaveLength(1);
        expect((yield* engine.status).starts).toBe(1);
      }),
    ),
  );

  it.effect("should signal only the spawn-time process group", () =>
    Effect.gen(function* () {
      let signals: ReadonlyArray<readonly [number, string]> = [];
      yield* withFakeEngine({}, (fake) =>
        Effect.gen(function* () {
          signals = fake.signals;
          const engine = yield* EngineService.EngineService;
          yield* engine.ping;
          expect(fake.signals).toEqual([]);
        }),
      );
      // Layer closed: stdin ended, SIGTERM to the group, then the spawner's own release.
      expect(signals).toEqual([
        [4242, "SIGTERM"],
        [4242, "spawner-release"],
      ]);
    }),
  );

  it.effect("should not inherit parent PATH or HOME paths under ~/.t3", () =>
    withFakeEngine({}, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        const config = yield* ServerConfig.ServerConfig;
        yield* engine.ping;
        const spawn = fake.spawns[0];
        assert(spawn !== undefined);
        expect(spawn.command).toMatch(/\/uv$/);
        expect(spawn.args.slice(0, 3)).toEqual(["run", "--frozen", "--offline"]);
        expect(spawn.env.PATH).toBe(ENGINE_SYSTEM_PATH);
        expect(spawn.env.HF_HUB_OFFLINE).toBe("1");
        expect(spawn.env.HF_HOME).toBe(config.engineModelsDir);
        expect(config.engineModelsDir.startsWith(config.stateDir)).toBe(true);
        expect(spawn.env.S7_FFMPEG).toMatch(/\/ffmpeg$/);
        expect(Object.keys(spawn.env)).not.toContain("S7VIDEO_UV");
        expect(Object.values(spawn.env).some((value) => value?.includes("/.t3"))).toBe(false);
      }),
    ),
  );

  it.effect("should fail in-flight calls with crashed and respawn", () =>
    withFakeEngine({}, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        yield* engine.ping;
        const hung = yield* engine.probe({ path: "/clip.mp4" }).pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Queue.end(fake.spawns[0]!.stdout);
        const error = yield* Fiber.join(hung);
        expect(error.reason).toBe("crashed");
        expect(error.message).toBe(
          "The video engine stopped during media.probe. It restarts on the next call; try again.",
        );
        expect((yield* engine.ping).pid).toBe(4343);
        expect(fake.spawns).toHaveLength(2);
      }),
    ),
  );

  it.effect("should time out a hung engine", () =>
    withFakeEngine({ callTimeout: "5 seconds" }, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        yield* engine.ping;
        yield* Queue.take(fake.requests);
        fake.control.hung = true;
        const hung = yield* engine.probe({ path: "/clip.mp4" }).pipe(Effect.flip, Effect.forkChild);
        expect(yield* Queue.take(fake.requests)).toBe("media.probe");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("6 seconds");
        // The health ping gets no answer either, so the engine is stopped through its own group.
        expect(yield* Queue.take(fake.requests)).toBe("engine.ping");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("6 seconds");
        const error = yield* Fiber.join(hung);
        expect(error.reason).toBe("timeout");
        expect(fake.signals).toContainEqual([4242, "SIGTERM"]);
        expect((yield* engine.status).pid).toBeUndefined();
        fake.control.hung = false;
        expect((yield* engine.ping).pid).toBe(4343);
      }),
    ),
  );

  it.effect("keeps a slow but healthy engine and its jobs", () =>
    withFakeEngine({ callTimeout: "5 seconds" }, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        yield* engine.ping;
        yield* Queue.take(fake.requests);
        const slow = yield* engine
          .probe({ path: "/long.webm" })
          .pipe(Effect.flip, Effect.forkChild);
        expect(yield* Queue.take(fake.requests)).toBe("media.probe");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("6 seconds");
        // The health ping is answered, so nothing is signalled and the same engine stays.
        expect((yield* Fiber.join(slow)).reason).toBe("timeout");
        expect(yield* Queue.take(fake.requests)).toBe("engine.ping");
        expect((yield* engine.ping).pid).toBe(4243);
        expect(fake.signals).toEqual([]);
        expect(fake.spawns).toHaveLength(1);
      }),
    ),
  );

  it.effect("spawns once for concurrent first calls", () =>
    withFakeEngine({}, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        const pongs = yield* Effect.all(
          Array.from({ length: 6 }, () => engine.ping),
          {
            concurrency: "unbounded",
          },
        );
        expect(pongs.map((pong) => pong.pid)).toEqual(Array.from({ length: 6 }, () => 4243));
        expect(fake.spawns).toHaveLength(1);
      }),
    ),
  );

  it.effect("reaps an engine whose caller is interrupted before ready", () =>
    withFakeEngine({}, (fake) =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        fake.control.ready = false;
        const starting = yield* engine.ping.pipe(Effect.forkChild);
        expect(yield* Queue.take(fake.spawned)).toBe(4242);
        yield* Fiber.interrupt(starting);
        expect(fake.signals).toEqual([
          [4242, "SIGTERM"],
          [4242, "spawner-release"],
        ]);
        expect((yield* engine.status).pid).toBeUndefined();
        fake.control.ready = true;
        expect((yield* engine.ping).pid).toBe(4343);
      }),
    ),
  );

  it.effect("reaps an engine that is still starting when the service shuts down", () =>
    Effect.gen(function* () {
      let signals: ReadonlyArray<readonly [number, string]> = [];
      yield* withFakeEngine({}, (fake) =>
        Effect.gen(function* () {
          signals = fake.signals;
          const engine = yield* EngineService.EngineService;
          fake.control.ready = false;
          yield* engine.ping.pipe(Effect.ignore, Effect.forkDetach);
          yield* Queue.take(fake.spawned);
          expect(fake.signals).toEqual([]);
        }),
      );
      expect(signals).toEqual([
        [4242, "SIGTERM"],
        [4242, "spawner-release"],
      ]);
    }),
  );

  it.effect("writes engine stderr to the engine log folder", () =>
    withFakeEngine({}, () =>
      Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* engine.ping;
        expect(config.engineLogsDir).toBe(path.join(config.logsDir, "engine"));
        const logFile = path.join(config.engineLogsDir, "engine.log");
        yield* Effect.promise(() =>
          expect.poll(() => NodeFS.readFileSync(logFile, "utf8")).toContain("engine log line"),
        );
        const text = yield* fileSystem.readFileString(logFile);
        expect(text).toMatch(/^--- engine pid 4242 started /);
        expect(text.includes("/.t3")).toBe(false);
      }),
    ),
  );
});

const toolPath = (name: string) =>
  ["/opt/homebrew/bin", "/usr/local/bin"]
    .map((directory) => `${directory}/${name}`)
    .find((candidate) => NodeFS.existsSync(candidate));
const realEngineAvailable = ["uv", "ffmpeg", "ffprobe"].every((name) => toolPath(name));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const realLayer = (options: EngineService.EngineServiceOptions = {}) =>
  EngineService.layerWith({ testMethods: true, ...options }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "engine-real-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const SlowJobResult = Schema.Struct({ path: Schema.String, steps: Schema.Int });

describe.skipIf(!realEngineAvailable)("EngineService with the real engine", () => {
  it.live("Server shutdown reaps both uv and its Python child", () =>
    Effect.gen(function* () {
      const pids = yield* Effect.gen(function* () {
        const engine = yield* EngineService.EngineService;
        const python = (yield* engine.ping).pid;
        const uv = (yield* engine.status).pid;
        assert(uv !== undefined);
        expect(python).not.toBe(uv);
        expect(isAlive(uv) && isAlive(python)).toBe(true);
        return { uv, python };
      }).pipe(Effect.provide(realLayer()));
      // Release waits for the group to exit before the layer finishes closing.
      expect(isAlive(pids.uv)).toBe(false);
      expect(isAlive(pids.python)).toBe(false);
    }),
  );

  it.live("Killing the engine process mid-call fails that call at once with crashed", () =>
    Effect.gen(function* () {
      const engine = yield* EngineService.EngineService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-crash-" });
      const first = yield* engine.ping;
      const uv = (yield* engine.status).pid;
      assert(uv !== undefined);
      const inFlight = yield* engine
        .runJob({
          kind: "test",
          method: "test.slowJob",
          params: { outputPath: path.join(directory, "slow.bin"), steps: 1000, stepMs: 50 },
          success: SlowJobResult,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* engine.subscribeJobs.pipe(
        Stream.filter((event) => event.type === "updated" && event.job.progress > 0),
        Stream.take(1),
        Stream.runDrain,
      );
      // SIGKILL to the spawn-time group: uv and Python die together, as in a real crash.
      process.kill(-uv, "SIGKILL");
      const error = yield* Fiber.join(inFlight);
      expect(error.reason).toBe("crashed");
      expect(error.message).toBe(
        "The video engine stopped during test.slowJob. It restarts on the next call; try again.",
      );
      const second = yield* engine.ping;
      expect(second.pid).not.toBe(first.pid);
      expect((yield* engine.status).starts).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(realLayer())),
  );

  it.live("should cancel a long job within 1 s", () =>
    Effect.gen(function* () {
      const engine = yield* EngineService.EngineService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-cancel-" });
      const output = path.join(directory, "partial.bin");
      const events: EngineJobsEvent[] = [];
      const progressed = yield* Deferred.make<EngineJobId>();
      yield* engine.subscribeJobs.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "updated" && event.job.progress > 0
                ? Deferred.succeed(progressed, event.job.id)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const job = yield* engine
        .runJob({
          kind: "test",
          method: "test.slowJob",
          params: { outputPath: output, steps: 1000, stepMs: 50 },
          success: SlowJobResult,
        })
        .pipe(Effect.flip, Effect.forkChild);
      const jobId = yield* Deferred.await(progressed);
      expect(yield* fileSystem.exists(output)).toBe(true);
      const before = yield* Clock.currentTimeMillis;
      expect(yield* engine.cancelJob(jobId)).toBe(true);
      const error = yield* Fiber.join(job);
      expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(1_000);
      expect(error.reason).toBe("cancelled");
      expect(yield* fileSystem.exists(output)).toBe(false);
      expect(yield* engine.cancelJob(jobId)).toBe(false);
      expect(events[0]).toEqual({ type: "snapshot", jobs: [] });
      expect(events.at(-1)).toMatchObject({
        type: "updated",
        job: { id: jobId, state: "cancelled" },
      });
    }).pipe(Effect.scoped, Effect.provide(realLayer())),
  );

  it.live("probes and grabs a frame as a PNG path, logging to the engine folder", () =>
    Effect.gen(function* () {
      const engine = yield* EngineService.EngineService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-media-" });
      const clip = path.join(directory, "clip.mp4");
      NodeChildProcess.execFileSync(toolPath("ffmpeg")!, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x240:r=30:d=2",
        "-c:v",
        "mpeg4",
        clip,
      ]);
      const probe = yield* engine.probe({ path: clip });
      expect(probe.video?.frameRate).toEqual({ num: 30, den: 1 });
      expect(probe.durationFrames).toBe(60);
      const frame = yield* engine.frame({ path: clip, frame: 30, rate: { num: 30, den: 1 } });
      expect(frame).toMatchObject({ frame: 30, width: 320, height: 240 });
      expect(frame.path).toMatch(/\.png$/);
      expect(yield* fileSystem.exists(frame.path)).toBe(true);
      const missing = yield* engine
        .probe({ path: path.join(directory, "none.mp4") })
        .pipe(Effect.flip);
      expect(missing.message).toBe("The video engine rejected media.probe: file not found.");
      const log = yield* fileSystem.readFileString(path.join(config.engineLogsDir, "engine.log"));
      expect(log).toMatch(/^--- engine pid \d+ started /);
      expect(log).not.toContain(clip);
      expect(log.includes("/.t3")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(realLayer())),
  );
});
