// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Reads committed fixture images synchronously.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { DesktopHeicConversionResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { assert, describe, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { convertHeic, convertHeicFile, isHeifFile, SIPS_TIMEOUT } from "./heicConversion.ts";

const fixture = (name: string) =>
  new Uint8Array(
    NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL(`../../../../../fixtures/images/${name}`, import.meta.url)),
    ),
  );

const argsOf = (command: ChildProcess.Command) => (command as ChildProcess.StandardCommand).args;

/** Wraps the real spawner and records every sips call, so tests can find the temp folder. */
const recordingSpawner = (calls: Array<ReadonlyArray<string>>) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) => {
        calls.push(argsOf(command));
        return real.spawn(command);
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));

const fakeHandle = (exitCode: Effect.Effect<number>, stdout = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.map(exitCode, ChildProcessSpawner.ExitCode),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const main = { webContents: { id: 1 } } as unknown as Electron.BrowserWindow;
const convert = (
  raw: unknown,
  options: {
    senderId?: number;
    platform?: NodeJS.Platform;
    calls?: Array<ReadonlyArray<string>>;
  } = {},
) =>
  convertHeic.handler(raw, { sender: { id: options.senderId ?? 1 } }).pipe(
    Effect.map((result) => result as DesktopHeicConversionResult),
    Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        recordingSpawner(options.calls ?? []),
        Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(main) }),
      ),
    ),
  );

const tempFolderOf = (calls: ReadonlyArray<ReadonlyArray<string>>) => {
  const source = calls[0]?.find((arg) => arg.endsWith("source.heic"));
  assert(source, "sips was not given the temp source file");
  return source.slice(0, source.lastIndexOf("/"));
};

describe("isHeifFile", () => {
  const ftyp = (major: string, ...compatible: string[]) => {
    const bytes = new Uint8Array(16 + compatible.length * 4);
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(new TextEncoder().encode(`ftyp${major}`), 4);
    compatible.forEach((brand, index) =>
      bytes.set(new TextEncoder().encode(brand), 16 + index * 4),
    );
    return bytes;
  };

  it.each([
    { name: "the HEIC fixture", data: fixture("portrait.heic"), heif: true },
    { name: "a mif1 compatible brand", data: ftyp("xxxx", "mp41", "mif1"), heif: true },
    { name: "a PNG", data: fixture("portrait.expected.png"), heif: false },
    { name: "an MP4", data: ftyp("isom", "mp41", "avc1"), heif: false },
    { name: "a truncated header", data: ftyp("heic").subarray(0, 12), heif: false },
  ])("recognises $name: $heif", ({ data, heif }) => {
    assert.strictEqual(isHeifFile(data), heif);
  });
});

// sips runs as a real subprocess, so these use the live clock for its timeout.
describe.runIf(HostProcess.Platform.defaultValue() === "darwin")("convertHeic", () => {
  it.live("converts a rotated HEIC to an upright JPEG or PNG and removes its temp folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const format of ["image/jpeg", "image/png"] as const) {
        const calls: Array<ReadonlyArray<string>> = [];
        const result = yield* convert({ data: fixture("portrait.heic"), format }, { calls });
        assert(result.ok, `expected ${format} to convert`);
        assert.strictEqual(result.mimeType, format);
        // The stored size is the shown size, so no orientation tag is left to apply.
        assert.deepEqual(readImageDimensions(result.data), { width: 128, height: 192 });
        assert.strictEqual(calls[0]?.[0], "-g", "dimensions are read before decoding");
        assert.isFalse(yield* fs.exists(tempFolderOf(calls)));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a corrupt HEIC as unreadable and removes its temp folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const calls: Array<ReadonlyArray<string>> = [];
      const truncated = fixture("portrait.heic").subarray(0, 300);
      assert.deepEqual(yield* convert({ data: truncated, format: "image/jpeg" }, { calls }), {
        ok: false,
        reason: "unreadable",
      });
      assert.isFalse(yield* fs.exists(tempFolderOf(calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("convertHeic guards", () => {
  it.effect("refuses other windows, non-macOS hosts and non-HEIF bytes before running sips", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const heic = { data: fixture("portrait.heic"), format: "image/jpeg" };
      assert.deepEqual(yield* convert(heic, { senderId: 2, calls }), {
        ok: false,
        reason: "unreadable",
      });
      assert.deepEqual(yield* convert(heic, { platform: "linux", calls }), {
        ok: false,
        reason: "unsupported",
      });
      for (const data of [fixture("portrait.expected.png"), new Uint8Array()]) {
        assert.deepEqual(yield* convert({ data, format: "image/png" }, { calls }), {
          ok: false,
          reason: "unreadable",
        });
      }
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects payloads over 50 MB and unknown formats", () =>
    Effect.gen(function* () {
      const reject = (raw: unknown) =>
        convert(raw).pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? "rejected" : "accepted")),
        );
      assert.strictEqual(
        yield* reject({ data: new Uint8Array(50 * 1024 * 1024 + 1), format: "image/jpeg" }),
        "rejected",
      );
      assert.strictEqual(
        yield* reject({ data: new Uint8Array([1]), format: "image/webp" }),
        "rejected",
      );
    }),
  );
});

describe("convertHeicFile with a fake sips", () => {
  const withSpawner = (spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"]) =>
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
      ),
    );

  it.effect("refuses a HEIC over the pixel cap without decoding it", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* convertHeicFile(fixture("portrait.heic"), "image/jpeg").pipe(
        withSpawner((command) =>
          Effect.sync(() => {
            calls.push(argsOf(command));
            return fakeHandle(Effect.succeed(0), "  pixelWidth: 8001\n  pixelHeight: 8000\n");
          }),
        ),
      );
      assert.deepEqual(result, { ok: false, reason: "too-large" });
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["-g"],
      );
    }),
  );

  it.effect("kills a hung sips at the timeout and removes the temp folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const started = yield* Deferred.make<string>();
      let killed = false;
      const fiber = yield* convertHeicFile(fixture("portrait.heic"), "image/jpeg").pipe(
        withSpawner((command) =>
          Effect.acquireRelease(
            Deferred.succeed(started, argsOf(command).at(-1)!).pipe(
              Effect.as(fakeHandle(Effect.never)),
            ),
            // Stands in for the real spawner, which kills the process when its scope closes.
            () =>
              Effect.sync(() => {
                killed = true;
              }),
          ),
        ),
        Effect.forkChild,
      );
      const source = yield* Deferred.await(started);
      assert.isTrue(yield* fs.exists(source));
      yield* TestClock.adjust(SIPS_TIMEOUT);
      assert.deepEqual(yield* Fiber.join(fiber), { ok: false, reason: "unreadable" });
      assert.isTrue(killed);
      assert.isFalse(yield* fs.exists(path.dirname(source)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
