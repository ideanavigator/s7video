import { expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS, BUILT_IN_USAGE_DRIVERS } from "./builtInDrivers.ts";

// s7video keeps Codex, Claude, Antigravity and the ACP registry; see docs/FORK.md (S7V-002).
it("registers only the providers the fork keeps", () => {
  expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual([
    "codex",
    "claudeAgent",
    "antigravity",
    "acpRegistry",
  ]);
  expect(BUILT_IN_USAGE_DRIVERS.map((driver) => driver.driverKind)).toEqual([
    "claudeAgent",
    "codex",
    "antigravity",
  ]);
});
