// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import defaultConfig from "../../../../s7video.config.ts";
import whiteLabelConfig from "../../../../configs/example-whitelabel.config.ts";
import { THEME_COLOR_ROLES } from "../themeColorRoles.ts";
import { BRAND } from "./brand.ts";
import { BrandConfigError, brandIdentity, decodeBrandConfig } from "./brandConfig.ts";

const withApp = (app: Record<string, unknown>) => ({
  ...defaultConfig,
  app: { ...defaultConfig.app, ...app },
});

describe("brandConfig", () => {
  it("accepts the default config", () => {
    const config = decodeBrandConfig(defaultConfig);
    expect(config.app).toMatchObject({
      productName: "s7video",
      bundleId: "app.s7video.desktop",
      protocol: "s7video",
      homeDir: ".s7video",
    });
    expect(BRAND).toEqual(config);
  });

  it("accepts the example white-label config with its own name and colours", () => {
    const config = decodeBrandConfig(whiteLabelConfig);
    expect(config.app.productName).toBe("Acme Studio");
    expect(config.app.homeDir).not.toBe(BRAND.app.homeDir);
    expect(config.theme.dark.colors.accent).not.toBe(BRAND.theme.dark.colors.accent);
  });

  it("rejects a missing name and names the field", () => {
    const { productName: _productName, ...app } = defaultConfig.app;
    expect(() => decodeBrandConfig({ ...defaultConfig, app }, "broken.config.ts")).toThrow(
      BrandConfigError,
    );
    expect(() => decodeBrandConfig({ ...defaultConfig, app }, "broken.config.ts")).toThrow(
      /broken\.config\.ts[\s\S]*\["app"\]\["productName"\]/,
    );
  });

  it.each([
    ["bundleId", "T3"],
    ["protocol", "Not A Scheme"],
    ["homeDir", "s7video"],
    ["id", ""],
  ])("rejects an invalid app.%s", (field, value) => {
    expect(() => decodeBrandConfig(withApp({ [field]: value }))).toThrow(
      new RegExp(`\\["app"\\]\\["${field}"\\]`),
    );
  });

  it.each([
    ["id", "t3code"],
    ["productName", "T3 Code"],
    ["bundleId", "com.t3tools.t3code"],
    ["protocol", "t3code"],
    ["homeDir", ".t3"],
    ["homeDir", ".T3"],
    ["cliName", "t3"],
  ])("rejects T3 Code's own app.%s %s", (field, value) => {
    expect(() => decodeBrandConfig(withApp({ [field]: value }))).toThrow(
      new RegExp(`T3 Code's own identity[\\s\\S]*\\["app"\\]\\["${field}"\\]`),
    );
  });

  it("rejects non-https URLs but allows empty optional endpoints", () => {
    expect(() =>
      decodeBrandConfig({ ...defaultConfig, urls: { ...defaultConfig.urls, homepage: "" } }),
    ).toThrow(/\["urls"\]\["homepage"\]/);
    expect(() =>
      decodeBrandConfig({
        ...defaultConfig,
        updates: { ...defaultConfig.updates, modelManifestUrl: "http://example.com/m.json" },
      }),
    ).toThrow(/\["updates"\]\["modelManifestUrl"\]/);
    expect(decodeBrandConfig(defaultConfig).updates).toEqual({
      githubRepository: "",
      npmPackage: "",
      installScriptUrl: "",
      modelManifestUrl: "",
    });
  });

  it("rejects a theme missing a colour role or using a non-hex colour", () => {
    const { accent: _accent, ...colors } = BRAND.theme.dark.colors;
    const dark = { ...BRAND.theme.dark, colors };
    expect(() => decodeBrandConfig({ ...defaultConfig, theme: { ...BRAND.theme, dark } })).toThrow(
      /\["theme"\]\["dark"\]\["colors"\]\["accent"\]/,
    );
    const light = { ...BRAND.theme.light, colors: { ...BRAND.theme.light.colors, text: "red" } };
    expect(() => decodeBrandConfig({ ...defaultConfig, theme: { ...BRAND.theme, light } })).toThrow(
      /\["theme"\]\["light"\]\["colors"\]\["text"\]/,
    );
  });

  it("defines every colour role in both theme files", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(Object.keys(BRAND.theme[mode].colors).toSorted()).toEqual(
        [...THEME_COLOR_ROLES].toSorted(),
      );
      expect(BRAND.theme[mode].mode).toBe(mode);
    }
  });

  it("derives separate development and production identities", () => {
    expect(brandIdentity(BRAND, false)).toEqual({
      protocol: "s7video",
      appId: "app.s7video.desktop",
      linuxDesktopEntryName: "app.s7video.desktop.desktop",
      userDataDirName: "s7video",
    });
    expect(brandIdentity(BRAND, true)).toEqual({
      protocol: "s7video-dev",
      appId: "app.s7video.desktop.dev",
      linuxDesktopEntryName: "app.s7video.desktop.dev.desktop",
      userDataDirName: "s7video-dev",
    });
  });
});
