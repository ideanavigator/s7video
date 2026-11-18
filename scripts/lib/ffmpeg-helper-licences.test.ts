// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Reads the committed allowlist and versions.lock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  buildconfProblems,
  checkHelperSources,
  type HelperAllowlist,
} from "./ffmpeg-helper-licences.ts";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const readJson = (file: string): unknown =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8"));
const ALLOWLIST = readJson("licenses.allowlist.json") as HelperAllowlist;
const LOCK = readJson("packages/engine/ffmpeg/versions.lock") as {
  sources: ReadonlyArray<Record<string, unknown>>;
  buildTools: ReadonlyArray<Record<string, unknown>>;
};

const withSource = (name: string, changes: Record<string, unknown>) => ({
  ...LOCK,
  sources: LOCK.sources.map((source) =>
    source.name === name ? { ...source, ...changes } : source,
  ),
});

describe("FFmpeg helper licences", () => {
  it("accepts the pinned sources and elects FTL for FreeType", () => {
    const result = checkHelperSources(LOCK, ALLOWLIST);
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(LOCK.sources.length + LOCK.buildTools.length);
    expect(result.elections).toEqual([
      expect.objectContaining({ name: "freetype", elected: "FTL" }),
    ]);
  });

  it("licence check rejects a GPL helper source", () => {
    const result = checkHelperSources(
      withSource("libass", { license: "GPL-2.0-or-later" }),
      ALLOWLIST,
    );
    expect(result.problems).toEqual([
      "libass@0.17.5 GPL-2.0-or-later: GPL-2.0-or-later is not on the allowlist",
    ]);
  });

  it("allows LGPL only as a dynamically linked helper library", () => {
    const result = checkHelperSources(withSource("fribidi", { linkage: "static" }), ALLOWLIST);
    expect(result.problems).toEqual([
      "fribidi@1.0.18 LGPL-2.1-or-later: LGPL is allowed only as a dynamically linked helper library",
    ]);
  });

  it("allows WTFPL for zimg only", () => {
    const result = checkHelperSources(withSource("harfbuzz", { license: "WTFPL" }), ALLOWLIST);
    expect(result.problems).toEqual(["harfbuzz@15.1.0 WTFPL: WTFPL is not on the allowlist"]);
  });

  it("needs a pinned hash and FFmpeg's release signature", () => {
    const unhashed = checkHelperSources(withSource("zimg", { sha256: "abc" }), ALLOWLIST);
    expect(unhashed.problems).toEqual(["zimg@3.0.6: needs a pinned lower-case sha256"]);
    const unsigned = checkHelperSources(withSource("ffmpeg", { signature: undefined }), ALLOWLIST);
    expect(unsigned.problems).toEqual([
      "ffmpeg@9.0.2: needs its release signature, key and key fingerprint",
    ]);
  });

  it("finds GPL, nonfree and version-3 flags in -buildconf", () => {
    const clean = "  configuration:\n    --disable-gpl\n    --enable-libass\n";
    expect(buildconfProblems(clean)).toEqual([]);
    expect(buildconfProblems(`${clean}    --enable-gpl\n    --enable-version3\n`)).toEqual([
      "the built FFmpeg helper was configured with --enable-gpl",
      "the built FFmpeg helper was configured with --enable-version3",
    ]);
    expect(buildconfProblems("")).toEqual(["ffmpeg -buildconf printed no configuration"]);
  });
});
