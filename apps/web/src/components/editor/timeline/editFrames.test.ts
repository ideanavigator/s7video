// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { editTimelinePlan, type PlaybackPlan } from "../../../editor/editPlayback";
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
    expect(editFrameToPlayerFrame(30, plan)).toBeNull();
    expect(editFrameToPlayerFrame(5, null)).toBeNull();
  });

  it("maps multi-clip edits one to one, gaps and reordered clips included", () => {
    const timeline = editTimelinePlan({
      fps: { num: 30, den: 1 },
      tracks: [
        {
          kind: "video",
          id: "v1",
          items: [
            { id: "i1", media: "b", start: 0, duration: 30, in: 300 },
            { id: "i2", media: "a", start: 60, duration: 30, in: 0 },
          ],
        },
      ],
    } as never);
    expect(playerFrameToEditFrame(45, timeline)).toBe(45);
    expect(editFrameToPlayerFrame(45, timeline)).toBe(45);
    expect(editFrameToPlayerFrame(89, timeline)).toBe(89);
    expect(editFrameToPlayerFrame(90, timeline)).toBeNull();
  });
});
