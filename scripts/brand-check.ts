#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain repository scan; no Effect runtime.
// `pnpm brand:check`: fails when branding leaks past s7video.config.ts. See docs/FORK.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { BrandConfig, BrandTheme } from "@t3tools/shared/brandConfig";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { REPOSITORY_ROOT, loadBrandConfig } from "./lib/brand-config.ts";

export interface BrandCheckProblem {
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

/** Upstream names and URLs that must come from the config, never from code. */
const BANNED_TEXT: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /T3 Code/g, label: '"T3 Code"' },
  { pattern: /T3 Tools/g, label: '"T3 Tools"' },
  { pattern: /t3\.codes/g, label: "t3.codes" },
  { pattern: /pingdotgg\/t3code/g, label: "pingdotgg/t3code" },
  // Bare `t3code`. Prefixed internal keys (`t3code:`, `t3code.`, `t3code/`) are storage keys, trace
  // attributes and lint rule ids kept for upstream merges, and pass. `t3code-*` names are caught below.
  { pattern: /(?<![\w./-])t3code(?![\w:/.-])/g, label: '"t3code"' },
  // T3 Code's data folder and identities: these are what would collide with an installed T3 Code.
  {
    pattern: /\$HOME\/\.t3\b|["'`/]\.t3["'`/]|\.join\([^)]*["']\.t3["']/g,
    label: "T3 Code's ~/.t3 folder",
  },
  { pattern: /com\.t3tools/g, label: "com.t3tools ids" },
  { pattern: /\bT3Code\b/g, label: '"T3Code"' },
  { pattern: /(?<![\w.-])t3code-[a-z]/g, label: "t3code-* names" },
  { pattern: /[`"']t3 [a-z]/g, label: "the t3 CLI name" },
  // The path data of T3's wordmark, as T3Wordmark.tsx and the DMG backgrounds drew it.
  { pattern: /M33\.4509 93V47\.56H15\.5309/g, label: "T3's wordmark artwork" },
];

/** Checked in code, HTML and SVG, comments stripped: what a user sees, not prose about upstream. */
const BANNED_CODE: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  // "T3 Code" and "T3 Tools" have their own rules; `T3.Env`, `T3-Mode-Limit` or `T3_` are not names.
  {
    pattern: /(?<![\w.$/-])T3(?![\w]|\.(?!app\b)[A-Za-z_]|-[A-Z]| Code\b| Tools\b)/g,
    label: '"T3" as a product name',
  },
  {
    pattern: /\bT3(?:Wordmark|AppIcon|Logo|Mark|Icon)\b/g,
    label: "T3's wordmark or icon component; use AppWordmark or AppIcon",
  },
];

/** SHA-256 of T3 Code's icon artwork as forked (S7V-100); none may come back. */
export const T3_ICON_SHA256: ReadonlySet<string> = new Set([
  "07792ad6e3f37735622e6c6077ff4e0b1f8d0a0e6f7822927f27521ff6a15781",
  "0a380d584db609cff025d0b99965062358021378f2102cf37196c616e444d1c8",
  "0b2e0bdd72508db0a5f475da22cfa603b0c1710c06cb411eaa5656fe5a39c495",
  "25f17fd73b3ecdebf05609b7f7625b824f490e017147ed56dc1dcb85251754e4",
  "347273f37a0bcdc0e9b168ff1252a33ad297271f5a84ad412c18c5e5ede8f450",
  "403e874556ffbecee8d1b2b5d612a874303fac791212a261bb3bd1b71d83e78d",
  "4512bba57cc8358616bdc10ada3890ddc15ddc74da41db117fa4275407781db4",
  "47f4843215db64e8acd7f235c7f7edee468aaaaf4a04d7dc08325e500ab9ab19",
  "4943ac41cc004f826c95d6da34e0b04c387cf54982fc424ba3da8b68dc4598db",
  "56a867bb173cee4e331cd434be4eaed632edcf1eff4208edbb5ed9bc2e7a5c8d",
  "7690419d25fb1b66520ee670742888557baac73c52de209228f9db82ca7d12ea",
  "7e59b6394016ef83ed1e946847769e01bf36d4062c5c5af2577fd3e228285fd9",
  "7fdcd08e83aedc4fc0d15a015a171b7bbd6025d37b2861e6ceb29a571813a91a",
  "98c0d91226cb253e421898c263c724f9bf2520a0983fc94052495ce184de9715",
  "9e1a20813a22f651978d6d3fc3cc6a9b9785538c0a3b634b94977b0026cae9f0",
  "a24a330d4f54798d1fa11f6decc1a300c1079caba13090376ee095e444c3555c",
  "af81af88788b6c90ccb974616a07e5f920885ecdafa34de67cf174e689673ea9",
  "d4c51fecaac2557d494f4fa30db42d56dc9b0fa7c0ee1e24aaede856f0924ac8",
  "e37b0f916fbc3c536206e64e1f865a1578374b575d2b7d7dc2968173d407b3b3",
  "e5bbd356347235456e424603fd0a7c0813d8cc6dd70bb9a82ca20f117e38a6f7",
  "e90f86b99e3126891caae7225cc0800d0a9efc7b3c216ab5cbce1a6586885111",
  "ec7e5c1b807e42fbda6b7bb4e4974f31668157e389f522bf4885b357a8ec9596",
  "f169d0a3bbcec493dd8aaa9e7afba6aff90b4f18c9d9b0e48c3c4d12d7c5d1e5",
  "f6039d9905a16ab1ac0c473b9abd1e3b778f139c783de3acbfb655632a75833c",
  "fbceddbceeb75136fb8e2c702cf0fe459d153b629abbda6262a63d7c4c65e673",
]);

/**
 * Checked in every tracked file, tests and allowed paths included: upstream's analytics destination
 * and any PostHog project key. The key pattern avoids spelling the prefix, so the ticket audit grep stays empty.
 */
const BANNED_ANALYTICS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /ingest\.t3\.codes/, label: "T3 Code's analytics host" },
  { pattern: /\bph[c]_[A-Za-z0-9]{16,}/, label: "a PostHog project key" },
];

/** T3 Code's identity blues. UI colours come from themes/*.json. */
const BANNED_COLOURS = [
  "#1b4ed8",
  "#346bf1",
  "#3160db",
  "#3061d9",
  "oklch(0.488 0.217 264)",
  "oklch(0.571 0.21 264)",
];

/** Paths where upstream names are expected: licences, attribution and upstream-tracking code. */
const ALLOWED_PATHS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /^(LICENSE|NOTICE)(\..*)?$/, reason: "licence and notice" },
  {
    pattern: /^(REUSE\.toml$|LICENSES\/)/,
    reason: "REUSE copyright annotations and licence texts",
  },
  { pattern: /^third-party-licenses/, reason: "licence notices" },
  { pattern: /^docs\/FORK\.md$/, reason: "fork record" },
  { pattern: /^s7video\.config\.ts$/, reason: "the config credits T3 Code" },
  { pattern: /^configs\//, reason: "example configs" },
  { pattern: /(^|\/)[^/]*\.(test|integration)\.[cm]?[jt]sx?$/, reason: "tests and their fixtures" },
  { pattern: /(^|\/)(fixtures|testkit|__snapshots__)\//, reason: "test fixtures" },
  { pattern: /^scripts\/brand-check\.ts$/, reason: "this check names what it bans" },
  { pattern: /^oxlint-plugin-t3code\//, reason: "upstream lint plugin; rule ids are t3code/*" },
  {
    pattern: /^packages\/contracts\/src\/t3ProjectFile\.ts$/,
    reason: "upstream t3.json project-file format and its published schema",
  },
  {
    pattern:
      /^apps\/server\/scripts\/(acp-mock-agent|dev-replay-agent|record-[\w-]+|fetch-expo-schema)\.ts$/,
    reason: "upstream mock agents and fixture recorders",
  },
  {
    pattern: /^packages\/shared\/src\/config\/brandConfig\.ts$/,
    reason: "names T3 Code's identity to reject it",
  },
  {
    pattern: /^(apps\/web\/test|packages\/(provider|source-control)-testing)\//,
    reason: "test helpers and fixtures",
  },
  {
    pattern: /^apps\/server\/src\/project\/AgentSessionScanner\.ts$/,
    reason: "skips sessions in T3 Code's worktrees so they are never imported",
  },
  {
    pattern: /^scripts\/seed-issue-21397(\.test)?\.py$/,
    reason: "refuses T3 Code's folder as its target and source",
  },
  {
    pattern:
      /^(packages\/contracts\/src\/auth|apps\/server\/src\/peer\/(PeerLinks|PeerMcpClient))\.ts$/,
    reason: "upstream peer-link protocol ids, shared by both ends of a link",
  },
  {
    pattern: /^(CHANGELOG|GOVERNANCE|PRIVACY|TRADEMARK)\.md$/,
    reason: "legal, credit and privacy text that must name T3 Code",
  },
  { pattern: /^evals\//, reason: "upstream model evals; fixtures name T3 Code's MCP tools" },
  { pattern: /^pnpm-lock\.yaml$/, reason: "lockfile" },
  { pattern: /^patches\//, reason: "dependency patches" },
  { pattern: /^packaging\/aur\//, reason: "upstream AUR packaging; not shipped by s7video" },
  {
    pattern: /^packages\/shared\/src\/config\/dataHome\.ts$/,
    reason: "names T3 Code's folder to refuse it",
  },
  {
    pattern: /^packages\/shared\/src\/(git|paletteSearch|t3McpToolPresentation)\.ts$/,
    reason: "recognizes upstream t3code/ branch names and T3 Code MCP tool names",
  },
  {
    pattern:
      /^(packages\/client-runtime\/src\/userMessage\.ts|apps\/web\/src\/components\/chat\/(QueuedRunsControl|TimelineUserMessageRow)\.tsx)$/,
    reason: 'the persisted "t3code" message attribution value in the event log',
  },
  {
    pattern: /^apps\/server\/src\/cloud\/npmRelease\.ts$/,
    reason: "reads the upstream `t3code` field of npm release manifests",
  },
];

/**
 * Not yet rebranded, each with an owner. Reported as warnings so the list stays visible; remove an
 * entry when its owner lands.
 */
export const PENDING_PATHS: ReadonlyArray<{ readonly pattern: RegExp; readonly owner: string }> = [
  {
    pattern: /^(README|CONTRIBUTING|AGENTS|CLAUDE|SECURITY)\.md$/,
    owner: "S7V-006/S7V-008",
  },
  { pattern: /^\.github\//, owner: "S7V-006 (templates), S7V-011 (workflows)" },
  { pattern: /^\.(cursor|devcontainer|agents|claude)\//, owner: "S7V-006 (contributor tooling)" },
  { pattern: /^docs\//, owner: "S7V-008 (user and operations docs)" },
  { pattern: /^(t3\.json|\.coderabbit\.yaml|\.mailmap|\.macroscope\/.*)$/, owner: "S7V-006" },
  { pattern: /^apps\/web\/vercel\.ts$/, owner: "S7V-011 (hosted web deploy)" },
  {
    pattern:
      /^(native\/|apps\/desktop\/gnome-extension\/|apps\/desktop\/resources\/installer\.nsh|apps\/desktop\/src\/snapShot\/(KdeSnapShot|linuxCaptureSession)\.ts)/,
    owner: "S7V-018 (Linux and Windows capture helpers, installer)",
  },
  {
    pattern: /^(scripts\/install\.(sh|ps1)|scripts\/npm-launcher\/)/,
    owner: "S7V-011 (CLI installers and npm launcher, unpublished)",
  },
];

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|wasm|node|zip|gz|tgz|sqlite|mp4|mov|mp3|wav|pdf|car)$/i;
const SCRIPT_EXTENSIONS = /\.([cm]?[jt]sx?)$/;
const MARKUP_EXTENSIONS = /\.(html|svg)$/;
const FONT_EXTENSIONS = /\.(woff2?|ttf|otf)$/i;

/** Blanks comments in JS/TS so only code and user-visible strings are checked. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote || (char === "\n" && quote !== "`")) quote = null;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
    i += 1;
  }
  return out;
}

/** Blanks `<!-- -->` comments, keeping line numbers. */
function stripMarkupComments(source: string): string {
  return source.replaceAll(/<!--[\s\S]*?-->/g, (comment) => comment.replaceAll(/[^\n]/g, " "));
}

export function findBannedText(file: string, contents: string): BrandCheckProblem[] {
  const isScript = SCRIPT_EXTENSIONS.test(file);
  const isMarkup = MARKUP_EXTENSIONS.test(file);
  const text = isScript
    ? stripComments(contents)
    : isMarkup
      ? stripMarkupComments(contents)
      : contents;
  const patterns = isScript || isMarkup ? [...BANNED_TEXT, ...BANNED_CODE] : BANNED_TEXT;
  const problems: BrandCheckProblem[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, index) => {
    for (const { pattern, label } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lineText)) {
        problems.push({
          file,
          line: index + 1,
          message: `hard-coded ${label}; read it from the brand config`,
        });
      }
    }
    const lower = lineText.toLowerCase();
    for (const colour of BANNED_COLOURS) {
      if (lower.includes(colour)) {
        problems.push({
          file,
          line: index + 1,
          message: `T3 Code colour ${colour}; use a theme token from themes/*.json`,
        });
      }
    }
  });
  return problems;
}

export function findAnalyticsTargets(file: string, contents: string): BrandCheckProblem[] {
  return contents.split("\n").flatMap((lineText, index) =>
    BANNED_ANALYTICS.filter(({ pattern }) => pattern.test(lineText)).map(({ label }) => ({
      file,
      line: index + 1,
      message: `${label}; telemetry destinations come from telemetry in the brand config`,
    })),
  );
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Text/background pairs that must meet WCAG 2.2 AA (4.5:1) in every theme. */
const CONTRAST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["text", "canvas"],
  ["text", "surface"],
  ["textMuted", "canvas"],
  ["textMuted", "surface"],
  ["sidebarForeground", "sidebar"],
  ["sidebarMutedForeground", "sidebar"],
  ["toolbarForeground", "toolbar"],
  ["messageForeground", "messageSurface"],
  ["messageActionForeground", "messageAction"],
  ["accentForeground", "accent"],
  ["codeForeground", "codeBackground"],
  ["terminalForeground", "terminalBackground"],
  ["textMuted", "messageSurface"],
  ["placeholder", "input"],
  ["placeholder", "surface"],
  ["updateForeground", "updateSurface"],
  ["mutedForeground", "muted"],
  ["secondaryLabel", "surface"],
  ["secondaryForeground", "secondary"],
  ["errorForeground", "errorSurface"],
  ["warningForeground", "warningSurface"],
  ["accentSurfaceForeground", "accentSurface"],
];

export function checkThemeContrast(name: string, theme: BrandTheme): BrandCheckProblem[] {
  const colors = theme.colors as Record<string, string>;
  return CONTRAST_PAIRS.flatMap(([foreground, background]) => {
    const ratio = contrastRatio(colors[foreground]!, colors[background]!);
    return ratio >= 4.5
      ? []
      : [
          {
            file: name,
            message: `${foreground} on ${background} has contrast ${ratio.toFixed(2)}:1; WCAG AA needs 4.5:1`,
          },
        ];
  });
}

export function checkUrls(config: BrandConfig): BrandCheckProblem[] {
  return Object.entries(config.urls).flatMap(([key, value]) =>
    value.trim() === "" ? [{ file: "brand config", message: `urls.${key} is empty` }] : [],
  );
}

export function checkIcons(
  root: string,
  paths: Readonly<Record<string, string>>,
): BrandCheckProblem[] {
  return Object.entries(paths).flatMap(([key, relative]) =>
    NodeFS.existsSync(NodePath.join(root, relative))
      ? []
      : [{ file: relative, message: `icon ${key} is missing` }],
  );
}

function listFiles(root: string, directory: string): string[] {
  const absolute = NodePath.join(root, directory);
  if (!NodeFS.existsSync(absolute)) return [];
  return NodeFS.readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      NodePath.relative(root, NodePath.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    );
}

const sha256 = (absolute: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(absolute)).digest("hex");

/** Fails on any file in `directories` whose bytes are one of T3 Code's icons. */
export function checkUpstreamIcons(
  root: string,
  directories: ReadonlyArray<string>,
  upstreamHashes: ReadonlySet<string> = T3_ICON_SHA256,
): BrandCheckProblem[] {
  return directories
    .flatMap((directory) => listFiles(root, directory))
    .filter((file) => upstreamHashes.has(sha256(NodePath.join(root, file))))
    .map((file) => ({
      file,
      message: "is T3 Code's icon artwork; export s7video's icons instead",
    }));
}

/** Dev and nightly builds must not look like a release in the Dock or a browser tab. */
export function checkChannelIconsDiffer(
  root: string,
  channels: Readonly<Record<string, ReadonlyArray<string>>>,
): BrandCheckProblem[] {
  const hash = (file: string) => {
    const absolute = NodePath.join(root, file);
    return NodeFS.existsSync(absolute) ? sha256(absolute) : undefined;
  };
  const [release, ...others] = Object.entries(channels);
  if (release === undefined) return [];
  const releaseHashes = release[1].map(hash);
  return others.flatMap(([name, files]) =>
    files
      .filter((file, index) => {
        const own = hash(file);
        return own !== undefined && own === releaseHashes[index];
      })
      .map((file) => ({ file, message: `the ${name} icon is identical to the ${release[0]} one` })),
  );
}

/** Every bundled font needs a licence file beside it. */
export function checkFontLicences(root: string, files: ReadonlyArray<string>): BrandCheckProblem[] {
  return files
    .filter((file) => FONT_EXTENSIONS.test(file) && !file.includes("node_modules/"))
    .flatMap((file) => {
      const directory = NodePath.join(root, NodePath.dirname(file));
      const hasLicence = NodeFS.readdirSync(directory).some((name) =>
        /^(LICEN[CS]E|OFL|COPYING)/i.test(name),
      );
      return hasLicence ? [] : [{ file, message: "bundled font has no licence file beside it" }];
    });
}

const matchesAny = (file: string, patterns: ReadonlyArray<{ readonly pattern: RegExp }>) =>
  patterns.some(({ pattern }) => pattern.test(file));

export function scanFiles(root: string, files: ReadonlyArray<string>) {
  const problems: BrandCheckProblem[] = [];
  const pending = new Map<string, number>();
  for (const file of files) {
    if (BINARY_EXTENSIONS.test(file)) continue;
    const absolute = NodePath.join(root, file);
    if (!NodeFS.existsSync(absolute) || !NodeFS.statSync(absolute).isFile()) continue;
    const contents = NodeFS.readFileSync(absolute, "utf8");
    problems.push(...findAnalyticsTargets(file, contents));
    if (matchesAny(file, ALLOWED_PATHS)) continue;
    const found = findBannedText(file, contents);
    if (found.length === 0) continue;
    const owner = PENDING_PATHS.find(({ pattern }) => pattern.test(file))?.owner;
    if (owner === undefined) problems.push(...found);
    else pending.set(owner, (pending.get(owner) ?? 0) + found.length);
  }
  return { problems, pending };
}

/** The icons that show which build is running: Dock, Windows and browser tab. */
export const CHANNEL_ICONS = {
  release: [
    BRAND_ASSET_PATHS.productionMacIconPng,
    BRAND_ASSET_PATHS.productionWindowsIconIco,
    BRAND_ASSET_PATHS.productionWebFavicon32Png,
  ],
  development: [
    BRAND_ASSET_PATHS.developmentDesktopIconPng,
    BRAND_ASSET_PATHS.developmentWindowsIconIco,
    BRAND_ASSET_PATHS.developmentWebFavicon32Png,
  ],
  nightly: [
    BRAND_ASSET_PATHS.nightlyMacIconPng,
    BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
  ],
};

function trackedFiles(root: string): string[] {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file.length > 0);
}

export async function runBrandCheck(
  env: Readonly<Record<string, string | undefined>> = process.env,
  root = REPOSITORY_ROOT,
) {
  const { path, config } = await loadBrandConfig(env);
  const files = trackedFiles(root);
  const scan = scanFiles(root, files);
  const problems = [
    ...checkUrls(config),
    ...checkIcons(root, BRAND_ASSET_PATHS),
    ...checkUpstreamIcons(root, [config.icons.directory, "apps/web/public"]),
    ...checkChannelIconsDiffer(root, CHANNEL_ICONS),
    ...checkFontLicences(root, files),
    ...checkThemeContrast(`${NodePath.relative(root, path)} theme.light`, config.theme.light),
    ...checkThemeContrast(`${NodePath.relative(root, path)} theme.dark`, config.theme.dark),
    ...scan.problems,
  ];
  return { problems, pending: scan.pending };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const { problems, pending } = await runBrandCheck();
  for (const [owner, count] of pending) {
    console.warn(`brand:check: ${count} upstream mention(s) pending, owned by ${owner}`);
  }
  for (const problem of problems) {
    console.error(`${problem.file}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`);
  }
  if (problems.length > 0) {
    console.error(`brand:check failed with ${problems.length} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log("brand:check passed.");
  }
}
