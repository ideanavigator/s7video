// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../../index.css";

import engineB from "../../../../../../fixtures/edit-documents/04-engine-b.json";
import ntsc from "../../../../../../fixtures/edit-documents/05-ntsc-2997.json";
import { makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import { render } from "../../../../test/render";
import { publishPlayerFrame } from "../../../editor/editStore";
import { Timeline } from "./Timeline";

const PROJECT_KEY = "env-1:project-1";
const LABELS_PX = 112;
const fiveTracks = engineB as unknown as EditDocument;

async function mount(
  document: EditDocument,
  options: { onSeek?: (frame: number) => void; playheadVisible?: boolean; width?: number } = {},
) {
  await page.viewport(1_280, 800);
  const container = window.document.createElement("div");
  container.style.cssText = `width: ${options.width ?? 1_112}px; height: 260px;`;
  const onSeek = vi.fn(options.onSeek ?? (() => {}));
  const ui = (next: EditDocument, playheadVisible = options.playheadVisible ?? true) => (
    <Timeline
      projectKey={PROJECT_KEY}
      document={next}
      playheadVisible={playheadVisible}
      initialFrame={0}
      onSeek={onSeek}
    />
  );
  const screen = await render(ui(document), { container, router: false });
  const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
  const playhead = container.querySelector<HTMLDivElement>("[data-testid=timeline-playhead]")!;
  const ppf = () => Number(scroller.dataset.pxPerFrame);
  /** A frame's left edge in viewport x. */
  const clientXOf = (frame: number) =>
    scroller.getBoundingClientRect().left + LABELS_PX + frame * ppf() - scroller.scrollLeft;
  return { screen, container, scroller, playhead, onSeek, ppf, clientXOf, ui };
}

const ctrlWheel = (target: Element, clientX: number, deltaY: number, key: "ctrlKey" | "metaKey") =>
  target.dispatchEvent(
    new WheelEvent("wheel", {
      clientX,
      clientY: target.getBoundingClientRect().top + 60,
      deltaY,
      [key]: true,
      bubbles: true,
      cancelable: true,
    }),
  );

describe("Timeline", () => {
  it("shows five labelled rows with every item at its edit.json frames", async () => {
    const view = await mount(fiveTracks);
    await using _screen = view.screen;
    for (const name of [
      "Overlays 1",
      "Overlays 2",
      "Video",
      "Captions",
      "Sound effects",
      "Music",
    ]) {
      await expect
        .element(view.screen.getByRole("list", { name: new RegExp(`^${name} track`) }))
        .toBeVisible();
    }
    for (const track of fiveTracks.tracks) {
      for (const item of track.items) {
        const block = view.container.querySelector<HTMLElement>(
          `[data-timeline-item="${item.id}"]`,
        );
        expect(block, item.id).not.toBeNull();
        expect(Number(block!.dataset.start)).toBe(item.start);
        expect(Number(block!.dataset.duration)).toBe(item.duration);
        // Read back from layout: the block sits at start × px-per-frame in the lane.
        const lane = block!.parentElement!.getBoundingClientRect();
        const left = block!.getBoundingClientRect().left - lane.left;
        expect(Math.abs(left - item.start * view.ppf())).toBeLessThan(0.5);
      }
    }
  });

  it("shows an agent edit without remounting", async () => {
    const view = await mount(fiveTracks);
    await using _screen = view.screen;
    const moved = structuredClone(fiveTracks) as unknown as {
      tracks: Array<{ items: Array<{ start: number }> }>;
    };
    moved.tracks[1]!.items[1]!.start += 7;
    const scroller = view.scroller;
    await view.screen.rerender(view.ui(moved as unknown as EditDocument));
    const caption = fiveTracks.tracks[1]!.items[1]!;
    await vi.waitFor(
      () =>
        expect(
          view.container
            .querySelector(`[data-timeline-item="${caption.id}"]`)
            ?.getAttribute("data-start"),
        ).toBe(String(caption.start + 7)),
      { timeout: 500 },
    );
    expect(view.container.querySelector("[data-testid=timeline-scroller]")).toBe(scroller);
  });

  it("says the edit will appear here when it has no items", async () => {
    const view = await mount({ ...fiveTracks, tracks: [] });
    await using _screen = view.screen;
    await expect.element(view.screen.getByText("Your edit will appear here")).toBeVisible();
  });

  it("seeks to the clicked frame on the ruler and on empty track area (8 of 8)", async () => {
    const view = await mount(fiveTracks);
    await using _screen = view.screen;
    const last = Math.max(
      ...fiveTracks.tracks.flatMap((track) =>
        track.items.map((item) => item.start + item.duration),
      ),
    );
    const ruler = view.container.querySelector("[data-timeline-ruler]")!;
    const music = view.container.querySelector("[data-timeline-row=music]")!;
    const frames = [3, 41, 97, 150, 233, 288, last - 40, last - 2];
    for (const [index, frame] of frames.entries()) {
      const target = index % 2 === 0 ? ruler : music;
      const rect = target.getBoundingClientRect();
      // The middle of the frame, so the click is inside it whatever the rounding.
      const x = view.clientXOf(frame + 0.5) - rect.left;
      await userEvent.click(target, { position: { x, y: rect.height - 3 } });
      expect(view.onSeek).toHaveBeenLastCalledWith(frame);
    }
    expect(view.onSeek).toHaveBeenCalledTimes(8);
  });

  it("zooms with ctrl or cmd + wheel keeping the frame under the cursor fixed", async () => {
    const view = await mount(makePerfEdit(300));
    await using _screen = view.screen;
    for (const [key, delta, at] of [
      ["ctrlKey", -300, 0.3],
      ["metaKey", -200, 0.7],
      ["ctrlKey", 150, 0.5],
    ] as const) {
      const rect = view.scroller.getBoundingClientRect();
      const clientX = rect.left + LABELS_PX + (rect.width - LABELS_PX) * at;
      const before = view.ppf();
      const frameUnder = (clientX - rect.left - LABELS_PX + view.scroller.scrollLeft) / before;
      ctrlWheel(view.scroller, clientX, delta, key);
      await vi.waitFor(() => expect(view.ppf()).not.toBe(before));
      // The same frame is still under the cursor, within a pixel.
      expect(Math.abs(view.clientXOf(frameUnder) - clientX)).toBeLessThanOrEqual(1);
    }
  });

  it("moves the playhead on each published player frame, outside React, and hides it for a clip", async () => {
    const view = await mount(fiveTracks);
    await using _screen = view.screen;
    for (const frame of [0, 17, 18, 240]) {
      publishPlayerFrame(PROJECT_KEY, frame);
      expect(view.playhead.dataset.frame).toBe(String(frame));
      const x = Number(/translate3d\(([\d.]+)px/.exec(view.playhead.style.transform)?.[1]);
      expect(x).toBeCloseTo(frame * view.ppf(), 2);
    }
    await view.screen.rerender(view.ui(fiveTracks, false));
    await vi.waitFor(() => expect(view.playhead.hidden).toBe(true));
    publishPlayerFrame(PROJECT_KEY, 999);
    expect(view.playhead.dataset.frame).toBe("240");
  });

  it("steps the playhead with the arrow keys and zooms with + and -", async () => {
    const view = await mount(fiveTracks);
    await using _screen = view.screen;
    const slider = view.screen.getByRole("slider", { name: "Playhead" });
    await userEvent.click(slider);
    view.onSeek.mockClear();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    const start = view.onSeek.mock.calls[0]![0] as number;
    expect(view.onSeek.mock.calls.map((call) => call[0])).toEqual([start, start + 1]);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(view.onSeek).toHaveBeenLastCalledWith(start + 31);
    const before = view.ppf();
    await userEvent.keyboard("+");
    await vi.waitFor(() => expect(view.ppf()).toBeGreaterThan(before));
    await expect
      .element(slider)
      .toHaveAttribute("aria-valuetext", expect.stringMatching(/^00:00:0\d:\d\d$/));
  });

  it("writes drop-frame timecode for 29.97 on the playhead slider", async () => {
    const view = await mount(ntsc as unknown as EditDocument);
    await using _screen = view.screen;
    publishPlayerFrame(PROJECT_KEY, 1_800);
    await expect
      .element(view.screen.getByRole("slider", { name: "Playhead" }))
      .toHaveAttribute("aria-valuetext", "00:01:00;02");
  });

  it("renders a 3-hour edit and a 1-frame clip at both ends of the zoom", async () => {
    const hours = 3 * 3600 * 30;
    const document = makePerfEdit(3_000, hours);
    const view = await mount(document);
    await using _screen = view.screen;
    // Fully zoomed out: everything fits; tiny clips are drawn into the canvas strips.
    expect(view.scroller.scrollWidth - view.scroller.clientWidth).toBeLessThan(
      view.scroller.clientWidth,
    );
    expect(view.container.querySelectorAll("canvas[data-lod-clips]").length).toBeGreaterThan(0);
    // Zoom all the way in near the end of the edit.
    const rect = view.scroller.getBoundingClientRect();
    const end = rect.right - 2;
    // Fully zoomed in, a 3-hour edit is capped by the browser's layout range (16 M px).
    const max = 16_000_000 / hours;
    while (view.ppf() < max - 1e-6) {
      const before = view.ppf();
      ctrlWheel(view.scroller, end, -1_000, "ctrlKey");
      await vi.waitFor(() => expect(view.ppf()).not.toBe(before));
    }
    // A clip near the 3-hour mark sits on its exact frame: no precision lost at 16 M px.
    const selector = "[data-timeline-row=video] [data-timeline-item]";
    await vi.waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull());
    const block = [...view.container.querySelectorAll<HTMLElement>(selector)].at(-1)!;
    const start = Number(block.dataset.start);
    expect(start).toBeGreaterThan(hours - 60 * 30);
    const lane = block.parentElement!.getBoundingClientRect();
    expect(
      Math.abs(block.getBoundingClientRect().left - lane.left - start * view.ppf()),
    ).toBeLessThan(1);

    const oneFrame = structuredClone(fiveTracks) as unknown as {
      tracks: Array<{ items: Array<{ duration: number }> }>;
    };
    oneFrame.tracks[4]!.items[0]!.duration = 1;
    const tiny = fiveTracks.tracks[4]!.items[0]!;
    const small = await mount(oneFrame as unknown as EditDocument);
    await using _small = small.screen;
    const overlayRow = small.container.querySelector(
      `[data-track-id="${fiveTracks.tracks[4]!.id}"]`,
    )!;
    const query = () => small.container.querySelector(`[data-timeline-item="${tiny.id}"]`);
    // Fully zoomed out the 1-frame clip is under 4 px, so the lane's canvas strip draws it.
    if (small.ppf() < 4) {
      expect(query()).toBeNull();
      expect(Number(overlayRow.querySelector("canvas")?.dataset.lodClips)).toBeGreaterThan(0);
    }
    // Fully zoomed in on it, it is a block one frame wide.
    while (small.ppf() < 1_000 / 8 - 1e-6) {
      const before = small.ppf();
      ctrlWheel(small.scroller, small.clientXOf(tiny.start + 0.5), -1_000, "ctrlKey");
      await vi.waitFor(() => expect(small.ppf()).not.toBe(before));
    }
    await vi.waitFor(() => expect(query()).not.toBeNull());
    expect(query()!.getBoundingClientRect().width).toBeCloseTo(small.ppf() - 1, 0);
  });

  it("keeps its scroll position when an edit arrives mid-scroll", async () => {
    const document = makePerfEdit(400);
    const view = await mount(document);
    await using _screen = view.screen;
    const rect = view.scroller.getBoundingClientRect();
    ctrlWheel(view.scroller, rect.left + 400, -600, "ctrlKey");
    await vi.waitFor(() => expect(view.scroller.scrollWidth).toBeGreaterThan(rect.width * 3));
    view.scroller.scrollLeft = 1_500;
    const next = structuredClone(document) as unknown as {
      tracks: Array<{ items: Array<{ duration: number }> }>;
    };
    next.tracks[2]!.items[0]!.duration += 1;
    await view.screen.rerender(view.ui(next as unknown as EditDocument));
    expect(view.scroller.scrollLeft).toBe(1_500);
  });
});
