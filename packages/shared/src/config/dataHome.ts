import { BRAND } from "./brand.ts";

/** T3 Code's data folder. s7video never reads or writes it, even when told to. */
export const UPSTREAM_T3_HOME_DIR = ".t3";

export const DATA_HOME_ENV = "S7VIDEO_HOME";

const trimSeparators = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");

/** True for `~/.t3` and anything inside it; callers pass absolute, normalized paths. */
export function isUpstreamT3Home(baseDir: string, homeDirectory: string): boolean {
  const upstream = `${trimSeparators(homeDirectory)}/${UPSTREAM_T3_HOME_DIR}`;
  const candidate = trimSeparators(baseDir);
  const fold = (value: string) => (/^[a-z]:\//i.test(value) ? value.toLowerCase() : value);
  return fold(candidate) === fold(upstream) || fold(candidate).startsWith(`${fold(upstream)}/`);
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

/** Returns `baseDir`, or throws when it is T3 Code's folder. */
export function guardDataHome(baseDir: string, homeDirectory: string): string {
  if (isUpstreamT3Home(baseDir, homeDirectory)) throw new UpstreamT3HomeError(baseDir);
  return baseDir;
}

export const defaultDataHome = (homeDirectory: string, join: (...parts: string[]) => string) =>
  join(homeDirectory, BRAND.app.homeDir);
