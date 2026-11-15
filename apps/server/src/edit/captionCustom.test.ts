// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// S7V-099: captions styled in words are said back in editing words, never codes or numbers.
import { describe, expect, it } from "@effect/vitest";

import { describeCaptionCustom } from "./captionCustom.ts";

describe("describeCaptionCustom", () => {
  it.each([
    [{ size: 1.4 }, undefined, "bigger"],
    [{ size: 1.2 }, undefined, "a bit bigger"],
    [{ size: 0.7 }, undefined, "smaller"],
    [{ size: 1.2 }, 1.4, "a bit smaller"],
    [{ size: 1.4 }, 1.2, "a bit bigger"],
    [{ size: 1.6 }, 1.2, "bigger"],
    [{ size: 0.8 }, 1.4, "smaller"],
    [{}, 1.4, "back to its own size"],
  ] as const)("size %o from %s is %s", (custom, before, words) => {
    expect(describeCaptionCustom(custom, "s7-neutral", before)).toBe(words);
  });

  it("names the skill's colours, says others plainly, and skips parts the look doesn't draw", () => {
    const custom = { textColor: "#FF8800", boxColor: "#0A84FF", position: "top" } as const;
    expect(describeCaptionCustom(custom, "s7-box")).toBe("orange, blue box, at the top");
    expect(describeCaptionCustom(custom, "s7-neutral")).toBe("orange, at the top");
    expect(describeCaptionCustom({ textColor: "#123456" }, "s7-neutral")).toBe(
      "a custom text colour",
    );
  });
});
