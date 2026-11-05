// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// No runtime imports: early-boot bundles import the config file directly and must stay small.
import type { BrandConfig } from "./brandConfig.ts";

type DeepEncoded = typeof BrandConfig.Encoded;

/** JSON imports widen literals, so theme files are typed loosely here and checked when decoded. */
export type BrandConfigInput = Omit<DeepEncoded, "theme"> & {
  readonly theme: { readonly light: unknown; readonly dark: unknown };
};

/** Typed identity used by config files; validation happens when the config is loaded. */
export function defineConfig(config: BrandConfigInput): BrandConfigInput {
  return config;
}
