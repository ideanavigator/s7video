// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Example partner build: S7VIDEO_CONFIG=configs/example-whitelabel.config.ts pnpm dev:desktop
import { defineConfig } from "../packages/shared/src/config/defineConfig.ts";
import base from "../s7video.config.ts";
import dark from "./example-whitelabel-dark.json" with { type: "json" };
import light from "./example-whitelabel-light.json" with { type: "json" };

export default defineConfig({
  ...base,
  app: {
    ...base.app,
    id: "acme-studio",
    productName: "Acme Studio",
    bundleId: "com.example.acmestudio",
    protocol: "acmestudio",
    homeDir: ".acme-studio",
    cliName: "acme-studio",
    publisher: "Acme Example Inc.",
  },
  urls: {
    ...base.urls,
    homepage: "https://example.com/acme-studio",
    issues: "https://example.com/acme-studio/support",
    docs: "https://example.com/acme-studio/docs",
  },
  theme: { light, dark },
});
