// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { formatMediaTimecode, spokenMediaLength } from "./mediaTimecode";

describe("formatMediaTimecode", () => {
  it("counts frames at the media's own rate", () => {
    expect(formatMediaTimecode(0, { num: 30, den: 1 })).toBe("0:00:00");
    expect(formatMediaTimecode(4_829, { num: 30, den: 1 })).toBe("2:40:29");
    expect(formatMediaTimecode(300, { num: 25, den: 1 })).toBe("0:12:00");
    // 23.976 counts 24 frames to the second, without drop-frame.
    expect(formatMediaTimecode(3_356, { num: 24_000, den: 1_001 })).toBe("2:19:20");
    expect(formatMediaTimecode(30 * 3_725, { num: 30, den: 1 })).toBe("1:02:05:00");
  });

  it("speaks the length in whole seconds", () => {
    expect(spokenMediaLength(45, { num: 30, den: 1 })).toBe("1 second");
    expect(spokenMediaLength(30 * 65, { num: 30, den: 1 })).toBe("1 minute 5 seconds");
    expect(spokenMediaLength(30 * 120, { num: 30, den: 1 })).toBe("2 minutes");
  });
});
