#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain repository scan; no Effect runtime.
// `pnpm brand:check`: fails when branding leaks past s7video.config.ts. See docs/FORK.md.
import * as NodeChildProcess from "node:child_process";
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
    pattern:
      /^(packages\/ssh\/|apps\/desktop\/src\/wsl\/|apps\/server\/src\/device\/(SshDeviceHost|sshDeviceScript)\.ts)/,
    owner: "S7V-018 (SSH, device-host and WSL: turned off, being removed)",
  },
  {
    pattern: /^(scripts\/install\.(sh|ps1)|scripts\/npm-launcher\/)/,
    owner: "S7V-011 (CLI installers and npm launcher, unpublished)",
  },
];

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|wasm|node|zip|gz|tgz|sqlite|mp4|mov|mp3|wav|pdf|car)$/i;
const SCRIPT_EXTENSIONS = /\.([cm]?[jt]sx?)$/;
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

export function findBannedText(file: string, contents: string): BrandCheckProblem[] {
  const text = SCRIPT_EXTENSIONS.test(file) ? stripComments(contents) : contents;
  const problems: BrandCheckProblem[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, index) => {
    for (const { pattern, label } of BANNED_TEXT) {
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
    if (BINARY_EXTENSIONS.test(file) || matchesAny(file, ALLOWED_PATHS)) continue;
    const absolute = NodePath.join(root, file);
    if (!NodeFS.existsSync(absolute) || !NodeFS.statSync(absolute).isFile()) continue;
    const found = findBannedText(file, NodeFS.readFileSync(absolute, "utf8"));
    if (found.length === 0) continue;
    const owner = PENDING_PATHS.find(({ pattern }) => pattern.test(file))?.owner;
    if (owner === undefined) problems.push(...found);
    else pending.set(owner, (pending.get(owner) ?? 0) + found.length);
  }
  return { problems, pending };
}

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
