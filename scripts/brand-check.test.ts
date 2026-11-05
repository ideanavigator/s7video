// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Builds small fixture trees on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BRAND } from "@t3tools/shared/brand";
import { describe, expect, it } from "vite-plus/test";

import {
  checkFontLicences,
  checkIcons,
  checkThemeContrast,
  checkUrls,
  findBannedText,
  runBrandCheck,
  scanFiles,
  stripComments,
} from "./brand-check.ts";

function fixtureTree(files: Record<string, string>): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7video-brand-check-"));
  for (const [file, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), contents);
  }
  return root;
}

describe("brand-check", () => {
  it("fails on a hard-coded T3 string in apps/web", () => {
    const root = fixtureTree({
      "apps/web/src/Banner.tsx": 'export const title = "Welcome to T3 Code";\n',
      "apps/web/src/links.ts": 'export const url = "https://t3.codes/download";\n',
    });
    const { problems } = scanFiles(root, ["apps/web/src/Banner.tsx", "apps/web/src/links.ts"]);
    expect(problems.map(({ file, line }) => `${file}:${line}`)).toEqual([
      "apps/web/src/Banner.tsx:1",
      "apps/web/src/links.ts:1",
    ]);
  });

  it("allows licences, tests, the fork record and listed upstream-tracking code", () => {
    const files = {
      LICENSE: "Copyright T3 Tools Inc.\n",
      "docs/FORK.md": "Fork of T3 Code (https://github.com/pingdotgg/t3code).\n",
      "apps/web/src/Banner.test.tsx": 'it("says T3 Code", () => {});\n',
      "packages/contracts/src/t3ProjectFile.ts": 'const url = "https://t3.codes/schema/t3.json";\n',
    };
    expect(scanFiles(fixtureTree(files), Object.keys(files)).problems).toEqual([]);
  });

  it("fails on upstream's analytics host or a PostHog key anywhere, allowed paths included", () => {
    // Built at run time so this file holds neither value itself.
    const host = ["ingest", "t3", "codes"].join(".");
    const key = `${"phc"}_${"A1b2".repeat(8)}`;
    const files = {
      "docs/FORK.md": `Upstream sent analytics to ${host}.\n`,
      "apps/server/src/telemetry/Example.test.ts": `const key = "${key}";\n`,
      "docs/user/telemetry.md": `PostHog project keys start with ${"phc"}_.\n`,
    };
    const { problems } = scanFiles(fixtureTree(files), Object.keys(files));
    expect(problems.map(({ file, line }) => `${file}:${line}`)).toEqual([
      "docs/FORK.md:1",
      "apps/server/src/telemetry/Example.test.ts:1",
    ]);
  });

  it("reports pending files by owner instead of failing", () => {
    const files = { "docs/user/install.md": "Install T3 Code.\n" };
    const { problems, pending } = scanFiles(fixtureTree(files), Object.keys(files));
    expect(problems).toEqual([]);
    expect([...pending.values()]).toEqual([1]);
  });

  it("checks code and strings but not comments", () => {
    const source = [
      "// Mirrors T3 Code's behaviour.",
      "/* T3 Code */ const a = 1;",
      'const b = "T3 Code";',
      "const c = `${a} T3 Code`;",
    ].join("\n");
    expect(stripComments(source)).not.toContain("Mirrors");
    expect(findBannedText("x.ts", source).map(({ line }) => line)).toEqual([3, 4]);
  });

  it("allows prefixed internal keys but not a bare t3code", () => {
    const allowed = [
      'const key = "t3code:themes:v1";',
      'const rule = "t3code/no-low-value-comments";',
      'const attribute = "t3code.release.channel";',
    ].join("\n");
    expect(findBannedText("x.ts", allowed)).toEqual([]);
    expect(findBannedText("x.ts", 'const scheme = "t3code";')).toHaveLength(1);
  });

  it.each([
    ['const home = "$HOME/.t3/runtime";', "~/.t3"],
    ['const dir = path.join(home, ".t3", "device");', "~/.t3"],
    ['const id = "com.t3tools.t3code";', "com.t3tools"],
    ['const key = "SOFTWARE\\\\T3Code";', "T3Code"],
    ['const prefix = "t3code-cookie-import-";', "t3code-*"],
    ['const hint = "Run `t3 up` again.";', "t3 CLI"],
    ["const hint = 't3 service install';", "t3 CLI"],
  ])("fails on %s (%s)", (source) => {
    expect(findBannedText("x.ts", source)).not.toEqual([]);
  });

  it("allows s7video's own folder, ids and CLI", () => {
    const source = [
      'const dir = path.join(home, ".s7video");',
      'const id = "app.s7video.desktop";',
      "const hint = `${BRAND.app.cliName} up`;",
      'const branch = "t3/add-search";',
    ].join("\n");
    expect(findBannedText("x.ts", source)).toEqual([]);
  });

  it("fails on T3 Code's identity colours outside the theme files", () => {
    expect(findBannedText("a.css", "--primary: oklch(0.488 0.217 264);")).toHaveLength(1);
    expect(findBannedText("a.ts", 'const accent = "#1B4ED8";')).toHaveLength(1);
  });

  it("fails on a low-contrast theme", () => {
    expect(checkThemeContrast("theme", BRAND.theme.dark)).toEqual([]);
    expect(checkThemeContrast("theme", BRAND.theme.light)).toEqual([]);
    const greyOnGrey = {
      ...BRAND.theme.light,
      colors: { ...BRAND.theme.light.colors, text: "#999999", surface: "#aaaaaa" },
    };
    const messages = checkThemeContrast("theme", greyOnGrey).map(({ message }) => message);
    expect(messages).toContainEqual(
      expect.stringMatching(/^text on surface has contrast .*WCAG AA needs 4\.5:1$/),
    );
  });

  it("fails on an empty URL, a missing icon and an unlicensed font", () => {
    expect(checkUrls({ ...BRAND, urls: { ...BRAND.urls, docs: " " } })).toEqual([
      { file: "brand config", message: "urls.docs is empty" },
    ]);
    const root = fixtureTree({
      "assets/prod/icon.png": "png",
      "fonts/licensed/Inter.woff2": "font",
      "fonts/licensed/OFL.txt": "licence",
      "fonts/bare/Mystery.ttf": "font",
    });
    expect(
      checkIcons(root, { present: "assets/prod/icon.png", absent: "assets/prod/gone.png" }),
    ).toEqual([{ file: "assets/prod/gone.png", message: "icon absent is missing" }]);
    expect(
      checkFontLicences(root, ["fonts/licensed/Inter.woff2", "fonts/bare/Mystery.ttf"]),
    ).toEqual([
      { file: "fonts/bare/Mystery.ttf", message: "bundled font has no licence file beside it" },
    ]);
  });

  it("passes on this repository with the default and the example white-label config", async () => {
    expect((await runBrandCheck({})).problems).toEqual([]);
    const whiteLabel = await runBrandCheck({
      S7VIDEO_CONFIG: "configs/example-whitelabel.config.ts",
    });
    expect(whiteLabel.problems).toEqual([]);
  });

  it("stops with a clear error when S7VIDEO_CONFIG names a missing file", async () => {
    await expect(runBrandCheck({ S7VIDEO_CONFIG: "configs/nope.config.ts" })).rejects.toThrow(
      /S7VIDEO_CONFIG points at configs\/nope\.config\.ts/,
    );
  });
});
