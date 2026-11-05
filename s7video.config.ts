// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The single brand config. Build with S7VIDEO_CONFIG=<path> to use another file (white-label builds).
import { defineConfig } from "./packages/shared/src/config/defineConfig.ts";
import dark from "./themes/s7video-dark.json" with { type: "json" };
import light from "./themes/s7video-light.json" with { type: "json" };

export default defineConfig({
  configVersion: 1,
  app: {
    id: "s7video",
    productName: "s7video",
    bundleId: "app.s7video.desktop",
    protocol: "s7video",
    homeDir: ".s7video",
    cliName: "s7video",
    publisher: "s7video contributors",
  },
  urls: {
    homepage: "https://github.com/ideanavigator/s7video",
    repository: "https://github.com/ideanavigator/s7video",
    issues: "https://github.com/ideanavigator/s7video/issues",
    docs: "https://github.com/ideanavigator/s7video/tree/main/docs",
    privacyPolicy: "https://github.com/ideanavigator/s7video/blob/main/PRIVACY.md",
  },
  // Empty values turn the endpoint off. s7video publishes no releases, npm package or manifest yet.
  updates: {
    githubRepository: "",
    npmPackage: "",
    installScriptUrl: "",
    modelManifestUrl: "",
  },
  telemetry: { host: "", key: "" },
  icons: { directory: "assets" },
  theme: { light, dark },
  credits: {
    upstreamName: "T3 Code",
    upstreamUrl: "https://github.com/pingdotgg/t3code",
    license: "MIT",
  },
});
