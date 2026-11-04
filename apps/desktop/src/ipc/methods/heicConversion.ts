import {
  DesktopHeicConversionInputSchema,
  DesktopHeicConversionResultSchema,
  type DesktopHeicConversionFormat,
  type DesktopHeicConversionResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const SIPS = "/usr/bin/sips";
const JPEG_QUALITY = "92";
const UNREADABLE: DesktopHeicConversionResult = { ok: false, reason: "unreadable" };

const runSips = Effect.fn("desktop.heic.runSips")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(SIPS, args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: "1 second",
    }),
  );
  const exitCode = yield* handle.exitCode.pipe(Effect.timeout("30 seconds"));
  if (exitCode !== 0) return yield* Effect.fail(`sips exited with ${exitCode}`);
});

/**
 * Electron's nativeImage cannot read HEIC, so this uses ImageIO through `sips`. BMP cannot store an
 * orientation or colour profile, so the first pass bakes EXIF rotation into the pixels and converts
 * to sRGB; the second encodes the requested format without either tag.
 */
export const convertHeicFile = Effect.fn("desktop.heic.convert")(function* (
  data: Uint8Array,
  format: DesktopHeicConversionFormat,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "heic-" });
      const source = path.join(directory, "source.heic");
      const upright = path.join(directory, "upright.bmp");
      const output = path.join(directory, format === "image/png" ? "output.png" : "output.jpg");
      yield* fs.writeFile(source, data);
      yield* runSips(["-s", "format", "bmp", source, "--out", upright]);
      yield* runSips(
        format === "image/png"
          ? ["-s", "format", "png", upright, "--out", output]
          : ["-s", "format", "jpeg", "-s", "formatOptions", JPEG_QUALITY, upright, "--out", output],
      );
      const converted = yield* fs.readFile(output);
      return { ok: true, data: converted, mimeType: format } satisfies DesktopHeicConversionResult;
    }),
  ).pipe(Effect.orElseSucceed(() => UNREADABLE));
});

export const convertHeic = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONVERT_HEIC_CHANNEL,
  payload: DesktopHeicConversionInputSchema,
  result: DesktopHeicConversionResultSchema,
  handler: Effect.fn("desktop.ipc.image.convertHeic")(function* ({ data, format }, event) {
    const window = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(window) ||
      window.value.webContents.id !== event.sender.id
    ) {
      return UNREADABLE;
    }
    if ((yield* HostProcess.Platform) !== "darwin") {
      return { ok: false, reason: "unsupported" } satisfies DesktopHeicConversionResult;
    }
    return yield* convertHeicFile(data, format);
  }),
});
