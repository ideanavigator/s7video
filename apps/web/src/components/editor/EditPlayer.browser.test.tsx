// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { clipPlaybackPlan, editPlaybackPlan, timeOfFrame } from "../../editor/editPlayback";
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

  it("steps from the frame on screen while playing, not from the last clock update", async () => {
    using _stubs = stubPlayback();
    const onPositionChange = vi.fn();
    await using screen = await renderPlayer({ onPositionChange });
    const video = (await screen.getByLabelText("interview.mov").findElement()) as HTMLVideoElement;
    await screen.getByRole("button", { name: "Play" }).click();
    // Playback moved on to frame 100 with no timeupdate yet.
    video.currentTime = timeOfFrame(100, FPS);
    await screen.getByRole("button", { name: "Next frame" }).click();
    expect(onPositionChange).toHaveBeenLastCalledWith(101);
  });

  // S7V-061: the player shows the edit's shape, as export renders it, inside its frame. The app's
  // stylesheet is loaded, so these are real layout sizes.
  it.each([
    { canvas: { width: 1080, height: 1920 }, panel: 640 },
    { canvas: { width: 1920, height: 1080 }, panel: 640 },
    // A wide panel: max-h caps the frame, so it is wider than 16:9.
    { canvas: { width: 1920, height: 1080 }, panel: 2400 },
    { canvas: { width: 2560, height: 1080 }, panel: 640 },
    { canvas: { width: 2560, height: 1080 }, panel: 2400 },
  ])(
    "fits a $canvas.width×$canvas.height edit inside a $panel px panel",
    async ({ canvas, panel }) => {
      using _stubs = stubPlayback();
      const plan = editPlaybackPlan({
        version: 1,
        fps: FPS,
        canvas,
        media: [],
        tracks: [
          {
            kind: "video",
            id: "v1",
            items: [{ id: "a", media: "clip", start: 0, duration: 60, in: 0 }],
          },
        ],
        markers: [],
        metadata: {},
      })!;
      await using screen = await render(
        <div style={{ width: panel }}>
          <EditPlayer
            projectKey="env-1:project-1"
            src=""
            label="interview.mov"
            plan={plan}
            startFrame={0}
            onPositionChange={vi.fn()}
            onError={vi.fn()}
          />
        </div>,
        { router: false },
      );
      const video = (await screen
        .getByLabelText("interview.mov")
        .findElement()) as HTMLVideoElement;
      const box = video.parentElement!;
      expect(box.dataset.canvas).toBe(`${canvas.width}x${canvas.height}`);
      const frame = box.parentElement!.parentElement!.getBoundingClientRect();
      const inner = box.getBoundingClientRect();
      expect(frame.width).toBeGreaterThan(0);
      // The whole canvas is visible: inside the frame on both axes, touching it on one, centred.
      expect(inner.width).toBeLessThanOrEqual(frame.width + 0.5);
      expect(inner.height).toBeLessThanOrEqual(frame.height + 0.5);
      expect(
        Math.abs(inner.width - frame.width) < 1 || Math.abs(inner.height - frame.height) < 1,
      ).toBe(true);
      expect(inner.width / inner.height).toBeCloseTo(canvas.width / canvas.height, 1);
      expect(inner.left - frame.left).toBeCloseTo(frame.right - inner.right, 0);
      expect(inner.top - frame.top).toBeCloseTo(frame.bottom - inner.bottom, 0);
      // The picture fills the canvas, cropped from the centre, as export renders it.
      expect(getComputedStyle(video).objectFit).toBe("cover");
      expect(video.getBoundingClientRect().width).toBeCloseTo(inner.width, 0);
    },
  );

  it("plays a raw clip whole, with no canvas", async () => {
    using _stubs = stubPlayback();
    await using screen = await renderPlayer();
    const video = (await screen.getByLabelText("interview.mov").findElement()) as HTMLVideoElement;
    expect(video.parentElement!.dataset.canvas).toBeUndefined();
    expect(getComputedStyle(video).objectFit).toBe("contain");
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
