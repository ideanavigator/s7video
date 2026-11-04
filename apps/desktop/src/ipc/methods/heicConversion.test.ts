import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { assert, describe, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { convertHeic } from "./heicConversion.ts";

const fixture = (name: string) =>
  new Uint8Array(
    NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL(`../../../../../fixtures/images/${name}`, import.meta.url)),
    ),
  );

const main = { webContents: { id: 1 } } as unknown as Electron.BrowserWindow;
const convert = (raw: unknown, senderId = 1, platform: NodeJS.Platform = "darwin") =>
  convertHeic
    .handler(raw, { sender: { id: senderId } })
    .pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(main) }),
        ),
      ),
    );

// sips runs as a real subprocess, so these use the live clock for its timeout.
describe.runIf(HostProcess.Platform.defaultValue() === "darwin")("convertHeic", () => {
  it.live("converts a rotated HEIC to an upright JPEG or PNG", () =>
    Effect.gen(function* () {
      for (const format of ["image/jpeg", "image/png"] as const) {
        const result = yield* convert({ data: fixture("portrait.heic"), format });
        assert(result.ok, `expected ${format} to convert`);
        assert.strictEqual(result.mimeType, format);
        // The stored size is the shown size, so no orientation tag is left to apply.
        assert.deepEqual(readImageDimensions(result.data), { width: 128, height: 192 });
      }
    }),
  );

  it.live("reports a corrupt HEIC as unreadable", () =>
    Effect.gen(function* () {
      const truncated = fixture("portrait.heic").subarray(0, 300);
      assert.deepEqual(yield* convert({ data: truncated, format: "image/jpeg" }), {
        ok: false,
        reason: "unreadable",
      });
      assert.deepEqual(yield* convert({ data: new Uint8Array(), format: "image/png" }), {
        ok: false,
        reason: "unreadable",
      });
    }),
  );
});

describe("convertHeic guards", () => {
  it.effect("ignores other windows and non-macOS hosts before decoding", () =>
    Effect.gen(function* () {
      const input = { data: new Uint8Array([1, 2, 3]), format: "image/jpeg" };
      assert.deepEqual(yield* convert(input, 2), { ok: false, reason: "unreadable" });
      assert.deepEqual(yield* convert(input, 1, "linux"), { ok: false, reason: "unsupported" });
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
