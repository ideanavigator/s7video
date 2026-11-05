import { assert, describe, it } from "@effect/vitest";

import { makeManagedSettings } from "./managedSettings.ts";

describe("makeManagedSettings", () => {
  it("refuses a policy that sets usage-data sharing, locked or not, on or off", () => {
    for (const value of [true, false]) {
      for (const locked of [true, false]) {
        const result = makeManagedSettings({ shareUsageData: { value, locked } });
        assert.equal(result._tag, "Invalid", JSON.stringify({ value, locked }));
        if (result._tag === "Invalid") assert.include(result.reason, "limits.telemetry: false");
      }
    }
  });
});
