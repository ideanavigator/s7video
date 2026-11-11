// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** S7V-036: our level presets, relative to the voice, as an item's own gain. */
import { describe, expect, it } from "vite-plus/test";

import { MUSIC_BED_DB, SFX_LEVEL_DB, defaultLevelDb, itemGainDb } from "./audioLevels.ts";

describe("audioLevels", () => {
  it("turns a preset relative to the voice into the item's gain on its own file", () => {
    expect(itemGainDb(-20, -10, SFX_LEVEL_DB.normal)).toBe(-19);
    expect(itemGainDb(-20.9, -24.6, SFX_LEVEL_DB.normal)).toBe(-5.3);
    expect(itemGainDb(-20.9, -30.9, MUSIC_BED_DB)).toBe(-8);
    expect(itemGainDb(-16, -16, 0)).toBe(0);
  });

  it("keeps the PO's defaults", () => {
    expect(SFX_LEVEL_DB).toEqual({ subtle: -14, normal: -9, hit: -6 });
    expect(defaultLevelDb("sfx")).toBe(-9);
    expect(defaultLevelDb("music")).toBe(-18);
  });
});
