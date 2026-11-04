// Schema for s7video.config.ts (or the S7VIDEO_CONFIG file): name, identity, data folder, URLs,
// update endpoints, telemetry target, icons and theme.
import * as Schema from "effect/Schema";

import { THEME_COLOR_ROLES } from "../themeColorRoles.ts";

const UPSTREAM_IDENTITY = "is T3 Code's own identity; s7video must not reuse it";
/** Rejects T3 Code's values, so a config can never collide with an installed T3 Code. */
const notUpstream = (isUpstream: (value: string) => boolean) =>
  Schema.makeFilter((value: string) =>
    isUpstream(value.trim().toLowerCase()) ? UPSTREAM_IDENTITY : true,
  );

const HexColor = Schema.String.check(
  Schema.isPattern(/^#[0-9a-fA-F]{6}$/, { message: "Expected a #rrggbb colour" }),
);

const HttpsUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/[^\s/]+(?:\/\S*)?$/, { message: "Expected an https:// URL" }),
);

/** Empty turns the endpoint off; anything else must be an https URL. */
const OptionalHttpsUrl = Schema.Union([Schema.Literal(""), HttpsUrl]);

const GitHubRepository = Schema.String.check(
  Schema.isPattern(/^(?:|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/, {
    message: 'Expected "owner/repo", or "" to turn it off',
  }),
);

const NpmPackageName = Schema.String.check(
  Schema.isPattern(/^(?:|(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/, {
    message: 'Expected an npm package name, or "" to turn it off',
  }),
);

const BrandThemeColors = Schema.Struct(
  Object.fromEntries(THEME_COLOR_ROLES.map((role) => [role, HexColor])) as {
    readonly [Role in (typeof THEME_COLOR_ROLES)[number]]: typeof HexColor;
  },
);

/** A theme file (`themes/*.json`). Every key becomes a CSS variable. */
export const BrandTheme = Schema.Struct({
  name: Schema.NonEmptyString,
  mode: Schema.Literals(["light", "dark"]),
  colors: BrandThemeColors,
  track: Schema.Struct({ video: HexColor, text: HexColor, sfx: HexColor, music: HexColor }),
  diff: Schema.Struct({ add: HexColor, remove: HexColor }),
  radius: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(32)),
});
export type BrandTheme = typeof BrandTheme.Type;

export const BrandConfig = Schema.Struct({
  configVersion: Schema.Literal(1),
  app: Schema.Struct({
    /** Lower-case id used for profile folders, CLI shims, service names and storage prefixes. */
    id: Schema.String.check(
      Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/, {
        message: "Expected a lower-case id such as s7video",
      }),
      notUpstream((value) => ["t3", "t3code", "t3-code"].includes(value)),
    ),
    /** Shown in window titles, menus, About and messages. */
    productName: Schema.NonEmptyString.check(
      notUpstream((value) => value.startsWith("t3 code") || value === "t3code"),
    ),
    /** macOS bundle id, Windows AppUserModelID and Linux desktop id. */
    bundleId: Schema.String.check(
      Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*){2,}$/, {
        message: "Expected a reverse-DNS id such as app.s7video.desktop",
      }),
      notUpstream((value) => value.startsWith("com.t3tools.")),
    ),
    /** Deep-link scheme. Development builds append `-dev`. */
    protocol: Schema.String.check(
      Schema.isPattern(/^[a-z][a-z0-9+.-]*$/, { message: "Expected a URL scheme such as s7video" }),
      notUpstream((value) => /^t3(code)?(-dev)?$/.test(value)),
    ),
    /** Data folder under the user's home. Development state goes to `<homeDir>/dev`. */
    homeDir: Schema.String.check(
      Schema.isPattern(/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/, {
        message: "Expected a dot-folder name such as .s7video",
      }),
      notUpstream((value) => value === ".t3"),
    ),
    /** Name of the command-line tool and the desktop app's CLI shim. */
    cliName: Schema.String.check(
      Schema.isPattern(/^[a-z][a-z0-9-]*$/, { message: "Expected a command name such as s7video" }),
      notUpstream((value) => ["t3", "t3code"].includes(value)),
    ),
    publisher: Schema.NonEmptyString,
  }),
  urls: Schema.Struct({
    homepage: HttpsUrl,
    repository: HttpsUrl,
    issues: HttpsUrl,
    docs: HttpsUrl,
    privacyPolicy: HttpsUrl,
  }),
  updates: Schema.Struct({
    /** GitHub repository that publishes desktop and CLI releases. Empty turns self-update off. */
    githubRepository: GitHubRepository,
    /** npm package checked for server updates. Empty turns the check off. */
    npmPackage: NpmPackageName,
    /** One-line install script shown in setup hints. Empty hides the hint. */
    installScriptUrl: OptionalHttpsUrl,
    /** Remote model manifest refreshed hourly. Empty uses the bundled manifest only. */
    modelManifestUrl: OptionalHttpsUrl,
  }),
  telemetry: Schema.Struct({
    /** PostHog-compatible ingest host. Empty sends nothing. */
    host: OptionalHttpsUrl,
    key: Schema.String,
  }),
  icons: Schema.Struct({
    /** Repository-relative folder holding the `prod`, `nightly` and `dev` icon sets. */
    directory: Schema.NonEmptyString,
  }),
  theme: Schema.Struct({ light: BrandTheme, dark: BrandTheme }),
  credits: Schema.Struct({
    upstreamName: Schema.NonEmptyString,
    upstreamUrl: HttpsUrl,
    license: Schema.NonEmptyString,
  }),
});
export type BrandConfig = typeof BrandConfig.Type;
export type { BrandConfigInput } from "./defineConfig.ts";

export class BrandConfigError extends Error {
  override readonly name = "BrandConfigError";
}

const decodeBrandConfigUnknown = Schema.decodeUnknownSync(BrandConfig, { errors: "all" });

/** Validates a config object. Throws `BrandConfigError` naming the source and each bad field. */

export function decodeBrandConfig(input: unknown, source = "s7video.config.ts"): BrandConfig {
  try {
    return decodeBrandConfigUnknown(input);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new BrandConfigError(`Invalid s7video config (${source}):\n${detail}`, { cause });
  }
}

/** `owner/repo` for a github.com URL, otherwise `null`. */
export function githubRepositorySlug(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Desktop and CLI identity derived from the config, one place for every surface. */
export function brandIdentity(config: BrandConfig, isDevelopment: boolean) {
  return {
    protocol: isDevelopment ? `${config.app.protocol}-dev` : config.app.protocol,
    appId: isDevelopment ? `${config.app.bundleId}.dev` : config.app.bundleId,
    linuxDesktopEntryName: isDevelopment
      ? `${config.app.bundleId}.dev.desktop`
      : `${config.app.bundleId}.desktop`,
    userDataDirName: isDevelopment ? `${config.app.id}-dev` : config.app.id,
  };
}
