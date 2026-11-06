// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { formatMediaLength, spokenMediaLength } from "./mediaTimecode";

describe("formatMediaLength", () => {
  it("shows whole minutes and seconds at the media's own rate", () => {
    expect(formatMediaLength(0, { num: 30, den: 1 })).toBe("0:00");
    expect(formatMediaLength(4_829, { num: 30, den: 1 })).toBe("2:40");
    expect(formatMediaLength(300, { num: 25, den: 1 })).toBe("0:12");
    // 139.8 s at 23.976 fps reads as 2:19, not 2:19:20 (which looks like hours).
    expect(formatMediaLength(3_352, { num: 24_000, den: 1_001 })).toBe("2:19");
    expect(formatMediaLength(30 * 3_599 + 29, { num: 30, den: 1 })).toBe("59:59");
    // Hours only from one hour up.
    expect(formatMediaLength(30 * 3_725, { num: 30, den: 1 })).toBe("1:02:05");
  });

  it("speaks the length in whole seconds", () => {
    expect(spokenMediaLength(45, { num: 30, den: 1 })).toBe("1 second");
    expect(spokenMediaLength(30 * 65, { num: 30, den: 1 })).toBe("1 minute 5 seconds");
    expect(spokenMediaLength(30 * 120, { num: 30, den: 1 })).toBe("2 minutes");
  });
});
