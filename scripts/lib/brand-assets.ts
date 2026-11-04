import { loadBrandConfig } from "./brand-config.ts";

/** Icon sets live under the brand config's `icons.directory` (`prod`, `nightly`, `dev`). */
const ICONS = (await loadBrandConfig()).config.icons.directory;

export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: `${ICONS}/dev/app-icon.icon`,
  developmentIosIconPng: `${ICONS}/dev/blueprint-ios-1024.png`,
  developmentUniversalIconPng: `${ICONS}/dev/blueprint-universal-1024.png`,

  productionIconComposerProject: `${ICONS}/prod/app-icon.icon`,
  productionIosIconPng: `${ICONS}/prod/black-ios-1024.png`,
  productionMacIconPng: `${ICONS}/prod/black-macos-1024.png`,
  productionLinuxIconPng: `${ICONS}/prod/black-universal-1024.png`,
  productionWindowsIconIco: `${ICONS}/prod/t3-black-windows.ico`,
  productionWebFaviconIco: `${ICONS}/prod/t3-black-web-favicon.ico`,
  productionWebFavicon16Png: `${ICONS}/prod/t3-black-web-favicon-16x16.png`,
  productionWebFavicon32Png: `${ICONS}/prod/t3-black-web-favicon-32x32.png`,
  productionWebAppleTouchIconPng: `${ICONS}/prod/t3-black-web-apple-touch-180.png`,

  nightlyIconComposerProject: `${ICONS}/nightly/app-icon.icon`,
  nightlyIosIconPng: `${ICONS}/nightly/nightly-ios-1024.png`,
  nightlyMacIconPng: `${ICONS}/nightly/nightly-macos-1024.png`,
  nightlyLinuxIconPng: `${ICONS}/nightly/nightly-universal-1024.png`,
  nightlyWindowsIconIco: `${ICONS}/nightly/nightly-windows.ico`,
  nightlyWebFaviconIco: `${ICONS}/nightly/nightly-web-favicon.ico`,
  nightlyWebFavicon16Png: `${ICONS}/nightly/nightly-web-favicon-16x16.png`,
  nightlyWebFavicon32Png: `${ICONS}/nightly/nightly-web-favicon-32x32.png`,
  nightlyWebAppleTouchIconPng: `${ICONS}/nightly/nightly-web-apple-touch-180.png`,

  developmentDesktopIconPng: `${ICONS}/dev/blueprint-macos-1024.png`,
  developmentWindowsIconIco: `${ICONS}/dev/blueprint-windows.ico`,
  developmentWebFaviconIco: `${ICONS}/dev/blueprint-web-favicon.ico`,
  developmentWebFavicon16Png: `${ICONS}/dev/blueprint-web-favicon-16x16.png`,
  developmentWebFavicon32Png: `${ICONS}/dev/blueprint-web-favicon-32x32.png`,
  developmentWebAppleTouchIconPng: `${ICONS}/dev/blueprint-web-apple-touch-180.png`,
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
