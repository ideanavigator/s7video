// @effect-diagnostics nodeBuiltinImport:off - Synchronous path checks run before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BRAND } from "./brand.ts";

/** T3 Code's data folder. s7video never reads or writes it, even when told to. */
export const UPSTREAM_T3_HOME_DIR = ".t3";

export const DATA_HOME_ENV = "S7VIDEO_HOME";

export interface DataHomeCheckOptions {
  /** Defaults to the running platform; macOS and Windows file systems ignore case. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `fs.realpathSync.native`; injectable for tests. */
  readonly realPath?: (path: string) => string;
}

const trimSeparators = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");

/** Real path of the nearest existing ancestor, with the missing tail re-appended. */
function canonicalPath(path: string, realPath: (path: string) => string): string {
  if (!NodePath.isAbsolute(path)) return path;
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return NodePath.join(realPath(current), ...[...missing].reverse());
    } catch {
      const parent = NodePath.dirname(current);
      if (parent === current) return path;
      missing.push(NodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * True for `~/.t3` and anything inside it, after resolving symlinks and, on macOS and Windows,
 * ignoring case (so `~/.T3` and a link to `~/.t3` are refused too).
 */
export function isUpstreamT3Home(
  baseDir: string,
  homeDirectory: string,
  options: DataHomeCheckOptions = {},
): boolean {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Sync guard, called outside Effect too.
  const platform = options.platform ?? process.platform;
  const realPath = options.realPath ?? NodeFS.realpathSync.native;
  const caseInsensitive =
    platform === "darwin" || platform === "win32" || /^[a-z]:[\\/]/i.test(baseDir);
  const normalize = (value: string) => {
    const trimmed = trimSeparators(value);
    return caseInsensitive ? trimmed.toLowerCase() : trimmed;
  };
  const candidates = [baseDir, canonicalPath(baseDir, realPath)].map(normalize);
  const upstreams = [
    `${trimSeparators(homeDirectory)}/${UPSTREAM_T3_HOME_DIR}`,
    trimSeparators(canonicalPath(NodePath.join(homeDirectory, UPSTREAM_T3_HOME_DIR), realPath)),
  ].map(normalize);
  return candidates.some((candidate) =>
    upstreams.some((upstream) => candidate === upstream || candidate.startsWith(`${upstream}/`)),
  );
}

export class UpstreamT3HomeError extends Error {
  override readonly name = "UpstreamT3HomeError";
  readonly baseDir: string;
  constructor(baseDir: string) {
    super(
      `${BRAND.app.productName} will not use ${baseDir}: that is T3 Code's data folder. Unset ${DATA_HOME_ENV} or --base-dir to use ~/${BRAND.app.homeDir}.`,
    );
    this.baseDir = baseDir;
  }
}

/** Returns `baseDir`, or throws when it is (or resolves into) T3 Code's folder. */
export function guardDataHome(
  baseDir: string,
  homeDirectory: string,
  options?: DataHomeCheckOptions,
): string {
  if (isUpstreamT3Home(baseDir, homeDirectory, options)) throw new UpstreamT3HomeError(baseDir);
  return baseDir;
}

export const defaultDataHome = (homeDirectory: string, join: (...parts: string[]) => string) =>
  join(homeDirectory, BRAND.app.homeDir);
