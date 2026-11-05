// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { clipPlaybackPlan, editPlaybackPlan } from "../../editor/editPlayback";
import { EditPlayer, type EditPlayerProps } from "./EditPlayer";

const FPS = { num: 30, den: 1 };

/** No media loads in these tests: `play()` only reports that playback started. */
const stubPlayback = () => {
  const frameRequests = vi.spyOn(HTMLVideoElement.prototype, "requestVideoFrameCallback");
  const frameCancels = vi.spyOn(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
  const animationFrames = vi.spyOn(window, "requestAnimationFrame");
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  return {
    frameRequests,
    frameCancels,
    animationFrames,
    play,
    [Symbol.dispose]: () => {
      for (const spy of [frameRequests, frameCancels, animationFrames, play]) spy.mockRestore();
    },
  };
};

const renderPlayer = (overrides: Partial<EditPlayerProps> = {}) => {
  const props: EditPlayerProps = {
    projectKey: "env-1:project-1",
    src: "",
    label: "interview.mov",
    plan: clipPlaybackPlan("clip", 300, FPS),
    startFrame: 0,
    onPositionChange: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  return render(<EditPlayer {...props} />, { router: false });
};

describe("EditPlayer", () => {
  it("should stop the frame loop when paused", async () => {
    using stubs = stubPlayback();
    await using screen = await renderPlayer();
    const video = (await screen.getByLabelText("interview.mov").findElement()) as HTMLVideoElement;
    // Paused after mounting: no frame callback and no animation frame loop.
    expect(stubs.frameRequests).not.toHaveBeenCalled();
    const animationFramesBefore = stubs.animationFrames.mock.calls.length;

    await screen.getByRole("button", { name: "Play" }).click();
    expect(stubs.play).toHaveBeenCalledOnce();
    expect(stubs.frameRequests).toHaveBeenCalledOnce();
    await expect.element(screen.getByRole("button", { name: "Pause" })).toBeVisible();

    await act(() => video.dispatchEvent(new Event("pause")));
    expect(stubs.frameCancels).toHaveBeenCalledWith(stubs.frameRequests.mock.results[0]!.value);
    await expect.element(screen.getByRole("button", { name: "Play" })).toBeVisible();
    expect(stubs.frameRequests).toHaveBeenCalledOnce();
    expect(stubs.animationFrames.mock.calls.length - animationFramesBefore).toBeLessThan(3);
  });

  it("plays and pauses with space, and steps frames and seconds with the arrow keys", async () => {
    using stubs = stubPlayback();
    const onPositionChange = vi.fn();
    await using screen = await renderPlayer({ onPositionChange });
    const player = screen.getByRole("group", { name: "Player: interview.mov" });
    await act(() => (player.element() as HTMLElement).focus());

    await userEvent.keyboard(" ");
    expect(stubs.play).toHaveBeenCalledOnce();

    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expect
      .element(screen.getByRole("slider", { name: "Position in the edit" }))
      .toHaveAttribute("aria-valuetext", "0:01");
    await userEvent.keyboard("{ArrowRight}");
    expect(onPositionChange).toHaveBeenLastCalledWith(31);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onPositionChange).toHaveBeenLastCalledWith(29);
    await expect.element(screen.getByText("0:00 / 0:10")).toBeVisible();
  });

  it("measures the clock in edit time, without the cut parts", async () => {
    using _stubs = stubPlayback();
    const plan = editPlaybackPlan({
      version: 1,
      fps: FPS,
      canvas: { width: 1920, height: 1080 },
      media: [],
      tracks: [
        {
          kind: "video",
          id: "v1",
          items: [
            { id: "a", media: "clip", start: 0, duration: 60, in: 0 },
            { id: "b", media: "clip", start: 60, duration: 60, in: 600 },
          ],
        },
      ],
      markers: [],
      metadata: {},
    })!;
    await using screen = await renderPlayer({ plan });
    await expect.element(screen.getByText("0:00 / 0:04")).toBeVisible();
    await expect
      .element(screen.getByRole("slider", { name: "Position in the edit" }))
      .toHaveAttribute("max", "119");
  });
});
