// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { isVideoToolName } from "./videoTools";

describe("isVideoToolName", () => {
  it("knows the video tools under any server prefix", () => {
    expect(isVideoToolName("video_export")).toBe(true);
    expect(isVideoToolName("mcp__t3-code__video_edit_read")).toBe(true);
    expect(isVideoToolName("t3-code.video_frame")).toBe(true);
  });

  it("ignores other tools", () => {
    expect(isVideoToolName("mcp__t3-code__preview_open")).toBe(false);
    expect(isVideoToolName("my_video_tool")).toBe(false);
    expect(isVideoToolName(null)).toBe(false);
  });
});
