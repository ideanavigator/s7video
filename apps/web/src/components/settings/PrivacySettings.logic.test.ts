import { describe, expect, it } from "vite-plus/test";

import { offeredUsageData } from "./PrivacySettings.logic";

describe("offeredUsageData", () => {
  it("hides the switch unless a server names a destination", () => {
    expect(offeredUsageData([])).toBeNull();
    expect(offeredUsageData([{ serverConfig: null }, { serverConfig: {} }])).toBeNull();
    expect(offeredUsageData([{ serverConfig: { usageData: { available: false } } }])).toBeNull();
  });

  it("offers the switch and names the variable that overrides it", () => {
    expect(offeredUsageData([{ serverConfig: { usageData: { available: true } } }])).toEqual({
      variable: undefined,
    });
    expect(
      offeredUsageData([
        { serverConfig: { usageData: { available: true } } },
        {
          serverConfig: {
            usageData: { available: true, variable: "S7VIDEO_TELEMETRY_ENABLED" },
          },
        },
      ]),
    ).toEqual({ variable: "S7VIDEO_TELEMETRY_ENABLED" });
  });
});
