// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The comparator decodes reference images with sips synchronously, outside the code under test.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { convertHeicFile } from "./heicConversion.ts";

const FIXTURES = NodeURL.fileURLToPath(new URL("../../../../../fixtures/images/", import.meta.url));

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly luma: Float64Array;
}

// The comparator decodes through ImageIO too; a BMP is simple enough to read here.
function decode(bytes: Uint8Array): Raster {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "heic-golden-"));
  try {
    const input = NodePath.join(directory, "input");
    const output = NodePath.join(directory, "output.bmp");
    NodeFS.writeFileSync(input, bytes);
    NodeChildProcess.execFileSync(
      "/usr/bin/sips",
      ["-s", "format", "bmp", input, "--out", output],
      {
        stdio: "ignore",
      },
    );
    const bmp = NodeFS.readFileSync(output);
    const offset = bmp.readUInt32LE(10);
    const width = bmp.readInt32LE(18);
    const signedHeight = bmp.readInt32LE(22);
    const height = Math.abs(signedHeight);
    const channels = bmp.readUInt16LE(28) / 8;
    const stride = Math.ceil((width * channels) / 4) * 4;
    const luma = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = offset + (signedHeight < 0 ? y : height - 1 - y) * stride;
      for (let x = 0; x < width; x++) {
        const i = row + x * channels;
        luma[y * width + x] = 0.114 * bmp[i]! + 0.587 * bmp[i + 1]! + 0.299 * bmp[i + 2]!;
      }
    }
    return { width, height, luma };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

/** Mean SSIM over 8x8 windows with a stride of 4 (Wang et al. 2004 constants). */
function ssim(a: Raster, b: Raster): number {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;
  for (let top = 0; top + 8 <= a.height; top += 4) {
    for (let left = 0; left + 8 <= a.width; left += 4) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = top; y < top + 8; y++) {
        for (let x = left; x < left + 8; x++) {
          const va = a.luma[y * a.width + x]!;
          const vb = b.luma[y * b.width + x]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / 64;
      const mb = sb / 64;
      const varA = saa / 64 - ma * ma;
      const varB = sbb / 64 - mb * mb;
      const cov = sab / 64 - ma * mb;
      total +=
        ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma ** 2 + mb ** 2 + c1) * (varA + varB + c2));
      windows++;
    }
  }
  return total / windows;
}

/** 64-bit average hash: each bit says whether an 8x8 grid cell is brighter than the mean. */
function averageHash(image: Raster): bigint {
  const cells: number[] = [];
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const x0 = Math.floor((column * image.width) / 8);
      const x1 = Math.floor(((column + 1) * image.width) / 8);
      const y0 = Math.floor((row * image.height) / 8);
      const y1 = Math.floor(((row + 1) * image.height) / 8);
      let sum = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) sum += image.luma[y * image.width + x]!;
      cells.push(sum / ((x1 - x0) * (y1 - y0)));
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  return cells.reduce((hash, value) => (hash << 1n) | (value > mean ? 1n : 0n), 0n);
}

const hammingDistance = (a: bigint, b: bigint) =>
  [...(a ^ b).toString(2)].filter((bit) => bit === "1").length;

const CASES = [
  { input: "landscape.heic", expected: "landscape.expected.png", width: 192, height: 128 },
  { input: "portrait.heic", expected: "portrait.expected.png", width: 128, height: 192 },
];

describe.runIf(HostProcess.Platform.defaultValue() === "darwin")("heic-to-jpeg golden", () => {
  // Live clock: sips runs as a real subprocess with a timeout.
  it.live.each(CASES)(
    "decodes $input upright and matches $expected",
    ({ input, expected, width, height }) =>
      Effect.gen(function* () {
        const source = new Uint8Array(NodeFS.readFileSync(NodePath.join(FIXTURES, input)));
        const result = yield* convertHeicFile(source, "image/jpeg");
        if (!result.ok) throw new Error(`could not convert ${input}`);

        // Stored size equals shown size: orientation is baked in, not left as a tag.
        expect(readImageDimensions(result.data)).toEqual({ width, height });
        const actual = decode(result.data);
        const reference = decode(
          new Uint8Array(NodeFS.readFileSync(NodePath.join(FIXTURES, expected))),
        );
        expect({ width: actual.width, height: actual.height }).toEqual({ width, height });
        expect(ssim(actual, reference)).toBeGreaterThanOrEqual(0.98);
        expect(hammingDistance(averageHash(actual), averageHash(reference))).toBeLessThanOrEqual(6);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
