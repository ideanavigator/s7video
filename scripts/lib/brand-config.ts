// @effect-diagnostics nodeBuiltinImport:off - Loaded by Vite configs and plain Node scripts before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { BrandConfigError, decodeBrandConfig, type BrandConfig } from "@t3tools/shared/brandConfig";

export const BRAND_CONFIG_ENV = "S7VIDEO_CONFIG";
export const REPOSITORY_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_BRAND_CONFIG_PATH = NodePath.join(REPOSITORY_ROOT, "s7video.config.ts");

/** The config file a build uses: `S7VIDEO_CONFIG` (relative to the repository root) or the default. */
export function resolveBrandConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  root = REPOSITORY_ROOT,
): string {
  const configured = env[BRAND_CONFIG_ENV]?.trim();
  if (!configured) return NodePath.join(root, "s7video.config.ts");
  const resolved = NodePath.resolve(root, configured);
  if (!NodeFS.existsSync(resolved)) {
    throw new BrandConfigError(
      `${BRAND_CONFIG_ENV} points at ${configured}, but ${resolved} does not exist.`,
    );
  }
  return resolved;
}

export async function loadBrandConfigFile(path: string): Promise<BrandConfig> {
  const module = (await import(NodeURL.pathToFileURL(path).href)) as { default?: unknown };
  if (module.default === undefined) {
    throw new BrandConfigError(`${path} has no default export. Export defineConfig({ ... }).`);
  }
  return decodeBrandConfig(module.default, NodePath.relative(REPOSITORY_ROOT, path) || path);
}

export async function loadBrandConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly path: string; readonly config: BrandConfig }> {
  const path = resolveBrandConfigPath(env);
  return { path, config: await loadBrandConfigFile(path) };
}

/**
 * Vite/rolldown plugin: validates the active config when a build starts (an invalid config fails
 * the build) and points every import of the default config at `S7VIDEO_CONFIG` when it is set.
 */
export function brandConfigPlugin(env: Readonly<Record<string, string | undefined>> = process.env) {
  const configPath = resolveBrandConfigPath(env);
  return {
    name: "s7video:brand-config",
    enforce: "pre" as const,
    async buildStart() {
      await loadBrandConfigFile(configPath);
    },
    /** index.html names the app before any script runs. */
    async transformIndexHtml(html: string) {
      const config = await loadBrandConfigFile(configPath);
      const name = config.app.productName
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return html.replaceAll("__S7VIDEO_PRODUCT_NAME__", name);
    },
    resolveId(source: string, importer: string | undefined) {
      if (configPath === DEFAULT_BRAND_CONFIG_PATH || importer === undefined) return null;
      // The override may spread the default config; that import must reach the real file.
      if (NodePath.resolve(importer) === configPath) return null;
      const target = NodePath.resolve(NodePath.dirname(importer), source);
      return target === DEFAULT_BRAND_CONFIG_PATH ? configPath : null;
    },
  };
}
