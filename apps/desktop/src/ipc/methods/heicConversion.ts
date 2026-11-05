import {
  HEIC_DECODE_MAX_PIXELS,
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
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const SIPS = "/usr/bin/sips";
const JPEG_QUALITY = "92";
export const SIPS_TIMEOUT = "30 seconds";
const UNREADABLE: DesktopHeicConversionResult = { ok: false, reason: "unreadable" };
const TOO_LARGE: DesktopHeicConversionResult = { ok: false, reason: "too-large" };
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** ImageIO sniffs content, so refuse anything that is not ISO-BMFF with a HEIF brand. */
export function isHeifFile(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fourCC = (offset: number) => String.fromCharCode(...data.subarray(offset, offset + 4));
  if (fourCC(4) !== "ftyp") return false;
  const end = Math.min(view.getUint32(0), data.length);
  if (end < 16) return false;
  if (HEIF_BRANDS.has(fourCC(8))) return true;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (HEIF_BRANDS.has(fourCC(offset))) return true;
  }
  return false;
}

const runSips = Effect.fn("desktop.heic.runSips")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(SIPS, args, {
      stdin: "ignore",
      stderr: "ignore",
      forceKillAfter: "1 second",
    }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
    { concurrency: "unbounded" },
  ).pipe(Effect.timeout(SIPS_TIMEOUT));
  if (exitCode !== 0) return yield* Effect.fail(`sips exited with ${exitCode}`);
  return stdout;
});

const readPixelCount = Effect.fn("desktop.heic.readPixelCount")(function* (source: string) {
  const report = yield* runSips(["-g", "pixelWidth", "-g", "pixelHeight", source]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(report)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(report)?.[1]);
  if (!(width > 0 && height > 0)) return yield* Effect.fail("sips reported no dimensions");
  return width * height;
});

/**
 * Electron's nativeImage cannot read HEIC, so this uses ImageIO through `sips`. The renderer's size
 * checks are repeated here before decoding. BMP cannot store an orientation or colour profile, so
 * the first pass bakes EXIF rotation into the pixels and converts to sRGB; the second encodes the
 * requested format without either tag.
 */
export const convertHeicFile = Effect.fn("desktop.heic.convert")(function* (
  data: Uint8Array,
  format: DesktopHeicConversionFormat,
) {
  if (!isHeifFile(data)) return UNREADABLE;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "heic-" });
      const source = path.join(directory, "source.heic");
      const upright = path.join(directory, "upright.bmp");
      const output = path.join(directory, format === "image/png" ? "output.png" : "output.jpg");
      yield* fs.writeFile(source, data);
      if ((yield* readPixelCount(source)) > HEIC_DECODE_MAX_PIXELS) return TOO_LARGE;
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
