// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import type { PlaybackPlan } from "../../../editor/editPlayback";
import { editFrameToPlayerFrame, playerFrameToEditFrame } from "./editFrames";

const plan: PlaybackPlan = {
  mediaId: "a",
  fps: { num: 30, den: 1 },
  segments: [{ sourceStart: 10, sourceEnd: 40, timelineStart: 0 }],
  durationFrames: 30,
  otherClipItems: 2,
};

describe("editFrames", () => {
  it("maps Engine A edits one to one", () => {
    expect(playerFrameToEditFrame(17, plan)).toBe(17);
    expect(editFrameToPlayerFrame(0, plan)).toBe(0);
    expect(editFrameToPlayerFrame(29, plan)).toBe(29);
  });

  it("has no player frame past what the plan plays, or without a plan", () => {
    // "Plays X only": a frame on a later clip must not snap the player to its last frame.
    expect(editFrameToPlayerFrame(30, plan)).toBeNull();
    expect(editFrameToPlayerFrame(5, null)).toBeNull();
  });
});
