// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import type { TimelinePlan } from "../../editor/editPlayback";
import { requestPlayerSeek, subscribePlayerFrame } from "../../editor/editStore";
import { Button } from "../ui/button";
import {
  MultiClipPlayer,
  type MultiClipPlayerProps,
  type MultiClipSource,
} from "./MultiClipPlayer";

const PROJECT_KEY = "env-1:project-multi";

const plan: TimelinePlan = {
  fps: { num: 30, den: 1 },
  segments: [
    { mediaId: "a", start: 0, end: 30, in: 0, muted: false },
    { mediaId: "b", start: 45, end: 75, in: 90, muted: false },
  ],
  durationFrames: 75,
  mediaIds: ["a", "b"],
  canvas: { width: 1080, height: 1920 },
};

const missing = (label: string): MultiClipSource => ({ label, url: null, status: "missing" });

const renderPlayer = (overrides: Partial<MultiClipPlayerProps> = {}) => {
  const props: MultiClipPlayerProps = {
    projectKey: PROJECT_KEY,
    plan,
    sources: new Map([
      ["a", missing("a.mov")],
      ["b", missing("b.mov")],
    ]),
    label: "a.mov and 1 more",
    startFrame: 0,
    onPositionChange: vi.fn(),
    onSourceError: vi.fn(),
    ...overrides,
  };
  return render(<MultiClipPlayer {...props} />, { router: false });
};

describe("MultiClipPlayer", () => {
  it("shows the other shapes inside the 16:9 frame, with a pool of hidden elements", async () => {
    await using screen = await renderPlayer();
    const stage = (await screen.getByTestId("multi-clip-stage").findElement()) as HTMLElement;
    expect(stage.querySelectorAll("video")).toHaveLength(3);
    const canvas = stage.closest("[data-canvas]") as HTMLElement;
    expect(canvas.dataset.canvas).toBe("1080x1920");
    const frame = canvas.parentElement!.parentElement!.getBoundingClientRect();
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);
    expect(canvas.getBoundingClientRect().height).toBeCloseTo(frame.height, 0);
  });

  it("should handle a missing source file", async () => {
    await using screen = await renderPlayer({
      renderSourceProblem: () => <Button size="sm">Find file…</Button>,
    });
    await expect.element(screen.getByText("Clip not found: a.mov")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Find file…" })).toBeVisible();
    // A gap shows plain black, with no message.
    await act(() => requestPlayerSeek(PROJECT_KEY, 35));
    await expect.element(screen.getByText("Clip not found: a.mov")).not.toBeInTheDocument();
    await act(() => requestPlayerSeek(PROJECT_KEY, 60));
    await expect.element(screen.getByText("Clip not found: b.mov")).toBeVisible();
  });

  it("plays through gaps and missing clips on its own clock, then stops at the end", async () => {
    const frames: number[] = [];
    const stop = subscribePlayerFrame(PROJECT_KEY, (frame) => frames.push(frame));
    await using screen = await renderPlayer({ startFrame: 70 });
    await screen.getByRole("button", { name: "Play" }).click();
    await expect.element(screen.getByRole("button", { name: "Play" })).toBeVisible();
    stop();
    expect(frames.at(-1)).toBe(74);
    expect(frames.filter((frame) => frame >= 70)).toEqual(expect.arrayContaining([70, 72, 74]));
  });

  it("does no work while paused, and follows seek requests", async () => {
    const animationFrames = vi.spyOn(window, "requestAnimationFrame");
    const frameRequests = vi.spyOn(HTMLVideoElement.prototype, "requestVideoFrameCallback");
    const onPositionChange = vi.fn();
    await using screen = await renderPlayer({ onPositionChange });
    const before = animationFrames.mock.calls.length;
    await act(() => requestPlayerSeek(PROJECT_KEY, 60));
    expect(onPositionChange).toHaveBeenLastCalledWith(60);
    await expect.element(screen.getByText("0:02 / 0:02")).toBeVisible();
    expect(animationFrames.mock.calls.length - before).toBeLessThan(3);
    expect(frameRequests).not.toHaveBeenCalled();
    animationFrames.mockRestore();
    frameRequests.mockRestore();
  });
});
