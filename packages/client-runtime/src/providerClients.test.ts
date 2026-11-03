import { describe, expect, it } from "vite-plus/test";

import { getProviderClient, providerClients } from "./providerClients.ts";

describe("providerClients", () => {
  // s7video keeps Codex, Claude, Antigravity and the ACP registry; see docs/FORK.md (S7V-002).
  it("lists only the providers the fork keeps", () => {
    expect(providerClients.definitions.map((definition) => definition.driverKind)).toEqual([
      "codex",
      "claudeAgent",
      "antigravity",
      "acpRegistry",
    ]);
  });

  it("has no client for a removed driver named in old settings", () => {
    for (const driver of ["cursor", "grok", "fx", "opencode", "muse", "pi"]) {
      expect(getProviderClient(driver)).toBeUndefined();
    }
  });
});
