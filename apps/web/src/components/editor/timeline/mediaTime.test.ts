// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { formatTimecode, frameAtSeconds, secondsOfFrame } from "./mediaTime";

const NTSC = { num: 30_000, den: 1_001 };
const NTSC60 = { num: 60_000, den: 1_001 };

describe("mediaTime", () => {
  it("handles 30, 25, 29.97 and 60 fps with no drift over 3 hours", () => {
    for (const fps of [{ num: 30, den: 1 }, { num: 25, den: 1 }, NTSC, { num: 60, den: 1 }]) {
      const frames = Math.round((3 * 3600 * fps.num) / fps.den);
      for (const frame of [0, 1, 1_799, frames - 1, frames]) {
        expect(frameAtSeconds(secondsOfFrame(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it("writes non-drop timecode at whole rates", () => {
    expect(formatTimecode(0, { num: 25, den: 1 })).toBe("00:00:00:00");
    expect(formatTimecode(25 * 61 + 3, { num: 25, den: 1 })).toBe("00:01:01:03");
    expect(formatTimecode(30 * 3600, { num: 30, den: 1 })).toBe("01:00:00:00");
  });

  it("writes drop-frame timecode at 29.97 and 59.94", () => {
    expect(formatTimecode(1_799, NTSC)).toBe("00:00:59;29");
    expect(formatTimecode(1_800, NTSC)).toBe("00:01:00;02");
    expect(formatTimecode(17_982, NTSC)).toBe("00:10:00;00");
    expect(formatTimecode(107_892, NTSC)).toBe("01:00:00;00");
    expect(formatTimecode(3_600, NTSC60)).toBe("00:01:00;04");
  });
});
