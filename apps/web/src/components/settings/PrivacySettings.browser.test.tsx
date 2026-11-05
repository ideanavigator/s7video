import type { ServerUsageData } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  usageData: undefined as ServerUsageData | undefined,
  update: vi.fn(),
}));

// The panel reads only which environments are in scope; the scope machinery has its own tests.
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: () => null,
  useSettingsScope: (() => ({
    connectedEnvironments: [{ serverConfig: { usageData: state.usageData } }],
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: (() => state.update) as never,
}));

import { PrivacySettingsPanel } from "./PrivacySettings";

describe("PrivacySettingsPanel", () => {
  it("links the privacy policy and offers no switch when the build names no destination", async () => {
    state.usageData = { available: false };
    await using screen = await render(<PrivacySettingsPanel />);
    await expect.element(screen.getByRole("link", { name: "View policy" })).toBeVisible();
    await expect
      .element(screen.getByText(/No usage data is sent unless you turn it on/))
      .toBeVisible();
    expect(screen.getByRole("switch").elements()).toHaveLength(0);
  });

  it("offers the switch off by default and says what would be sent", async () => {
    state.usageData = { available: true };
    await using screen = await render(<PrivacySettingsPanel />);
    const toggle = screen.getByRole("switch", { name: "Share pseudonymous usage data" });
    await expect.element(toggle).not.toBeChecked();
    await expect.element(toggle).toBeEnabled();
    await expect
      .element(screen.getByText(/one-way hashes of the OpenAI and Claude accounts/))
      .toBeVisible();
  });

  it("locks the switch while an environment variable decides", async () => {
    state.usageData = { available: true, variable: "S7VIDEO_TELEMETRY_ENABLED" };
    await using screen = await render(<PrivacySettingsPanel />);
    await expect
      .element(screen.getByRole("switch", { name: "Share pseudonymous usage data" }))
      .toBeDisabled();
    await expect.element(screen.getByText(/Set by S7VIDEO_TELEMETRY_ENABLED/)).toBeVisible();
  });
});
