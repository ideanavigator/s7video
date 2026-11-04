// @effect-diagnostics nodeBuiltinImport:off - Exercises the Node loader used by Vite configs and scripts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BRAND_CONFIG_PATH,
  REPOSITORY_ROOT,
  brandConfigPlugin,
  loadBrandConfig,
  loadBrandConfigFile,
  resolveBrandConfigPath,
} from "./brand-config.ts";

const EXAMPLE = "configs/example-whitelabel.config.ts";
const ACTIVE_MODULE = NodePath.join(REPOSITORY_ROOT, "packages/shared/src/config/brand.ts");

function writeTempConfig(contents: string): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7video-config-"));
  const file = NodePath.join(directory, "broken.config.ts");
  NodeFS.writeFileSync(file, contents);
  return file;
}

describe("brand-config", () => {
  it("uses s7video.config.ts unless S7VIDEO_CONFIG is set", async () => {
    expect(resolveBrandConfigPath({})).toBe(DEFAULT_BRAND_CONFIG_PATH);
    expect(resolveBrandConfigPath({ S7VIDEO_CONFIG: "  " })).toBe(DEFAULT_BRAND_CONFIG_PATH);
    const loaded = await loadBrandConfig({});
    expect(loaded.config.app.productName).toBe("s7video");
  });

  it("loads the override named by S7VIDEO_CONFIG, relative to the repository root", async () => {
    const loaded = await loadBrandConfig({ S7VIDEO_CONFIG: EXAMPLE });
    expect(loaded.path).toBe(NodePath.join(REPOSITORY_ROOT, EXAMPLE));
    expect(loaded.config.app.productName).toBe("Acme Studio");
  });

  it("fails clearly when S7VIDEO_CONFIG names a missing file", () => {
    expect(() => resolveBrandConfigPath({ S7VIDEO_CONFIG: "configs/missing.config.ts" })).toThrow(
      /S7VIDEO_CONFIG points at configs\/missing\.config\.ts, but .* does not exist/,
    );
  });

  it("fails the build on an invalid config, naming the field", async () => {
    const file = writeTempConfig(`export default { configVersion: 2 };\n`);
    await expect(loadBrandConfigFile(file)).rejects.toThrow(/Invalid s7video config/);
    const plugin = brandConfigPlugin({ S7VIDEO_CONFIG: file });
    await expect(plugin.buildStart()).rejects.toThrow(/\["configVersion"\]/);
    await expect(loadBrandConfigFile(writeTempConfig("export const x = 1;\n"))).rejects.toThrow(
      /no default export/,
    );
  });

  it("names the app in index.html from the active config", async () => {
    const html = `<title>__S7VIDEO_PRODUCT_NAME__</title><img alt="__S7VIDEO_PRODUCT_NAME__" />`;
    expect(await brandConfigPlugin({}).transformIndexHtml(html)).toBe(
      `<title>s7video</title><img alt="s7video" />`,
    );
    expect(await brandConfigPlugin({ S7VIDEO_CONFIG: EXAMPLE }).transformIndexHtml(html)).toBe(
      `<title>Acme Studio</title><img alt="Acme Studio" />`,
    );
  });

  it("points imports of the default config at the override", () => {
    const override = NodePath.join(REPOSITORY_ROOT, EXAMPLE);
    const plugin = brandConfigPlugin({ S7VIDEO_CONFIG: EXAMPLE });
    expect(plugin.resolveId("../../../../s7video.config.ts", ACTIVE_MODULE)).toBe(override);
    // The example spreads the default config; that import must not loop back to itself.
    expect(plugin.resolveId("../s7video.config.ts", override)).toBeNull();
    expect(plugin.resolveId("./other.ts", ACTIVE_MODULE)).toBeNull();
    // Early-boot bundles import the config file directly; they follow the override too.
    const compileCache = NodePath.join(REPOSITORY_ROOT, "apps/desktop/src/compileCache.ts");
    expect(plugin.resolveId("../../../s7video.config.ts", compileCache)).toBe(override);
    expect(brandConfigPlugin({}).resolveId("../../../../s7video.config.ts", ACTIVE_MODULE)).toBe(
      null,
    );
  });
});
