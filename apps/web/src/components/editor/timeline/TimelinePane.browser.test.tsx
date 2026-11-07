// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EditDocument } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../../index.css";

import engineB from "../../../../../../fixtures/edit-documents/04-engine-b.json";
import { makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import { render } from "../../../../test/render";
import { TimelinePane } from "./TimelinePane";

const STORAGE_KEY = "editor-timeline-height:v1";

async function mountPane(document: EditDocument, panelHeight = 800) {
  await page.viewport(1_280, 900);
  const container = window.document.createElement("div");
  container.style.cssText = `display:flex;flex-direction:column;width:900px;height:${panelHeight}px`;
  const screen = await render(
    <TimelinePane
      projectKey="env-1:project-1"
      document={document}
      playheadVisible
      initialFrame={0}
      onSeek={() => {}}
      plan={null}
      projectRef={{ environmentId: "env-1" as never, projectId: "project-1" as never }}
      mediaById={new Map()}
    />,
    { container, router: false },
  );
  const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
  return { screen, container, scroller };
}

const wheel = (target: Element, deltaY: number) =>
  target.dispatchEvent(
    new WheelEvent("wheel", {
      clientX: target.getBoundingClientRect().left + 400,
      clientY: target.getBoundingClientRect().top + 80,
      deltaY,
      bubbles: true,
      cancelable: true,
    }),
  );

describe("TimelinePane", () => {
  it("shows all five rows at the default height, and a mouse wheel scrolls sideways", async () => {
    localStorage.removeItem(STORAGE_KEY);
    const pane = await mountPane(makePerfEdit(1_000));
    await using _screen = pane.screen;
    for (const kind of ["overlay", "video", "caption", "sfx", "music"]) {
      const row = pane.container
        .querySelector(`[data-timeline-row=${kind}]`)!
        .getBoundingClientRect();
      expect(row.bottom, kind).toBeLessThanOrEqual(
        pane.scroller.getBoundingClientRect().bottom - 15,
      );
    }
    expect(pane.scroller.scrollHeight).toBeLessThanOrEqual(pane.scroller.clientHeight + 16);
    // Zoom in so the edit is wider than the timeline, then a plain wheel moves it sideways.
    pane.scroller.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: pane.scroller.getBoundingClientRect().left + 400,
        deltaY: -600,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(pane.scroller.scrollWidth).toBeGreaterThan(pane.scroller.clientWidth * 2),
    );
    const before = pane.scroller.scrollLeft;
    wheel(pane.scroller, 120);
    await vi.waitFor(() => expect(pane.scroller.scrollLeft).toBe(before + 120));
  });

  it("raises a stored height below the rows, and lowers one that would squeeze the player", async () => {
    localStorage.setItem(STORAGE_KEY, "150");
    const short = await mountPane(engineB as unknown as EditDocument);
    const shortHeight = short.container.querySelector("section")!.getBoundingClientRect().height;
    expect(shortHeight).toBeGreaterThan(220);
    await short.screen[Symbol.asyncDispose]();

    localStorage.setItem(STORAGE_KEY, "700");
    const tall = await mountPane(engineB as unknown as EditDocument, 600);
    await using _tall = tall.screen;
    await vi.waitFor(() =>
      expect(tall.container.querySelector("section")!.getBoundingClientRect().height).toBe(
        600 - 240,
      ),
    );
    localStorage.removeItem(STORAGE_KEY);
  });

  it("wheels the rows first when they overflow, then sideways at their edge", async () => {
    localStorage.removeItem(STORAGE_KEY);
    // Three more overlay tracks make the rows taller than the default timeline.
    const document = makePerfEdit(300);
    const overlay = document.tracks.find((track) => track.kind === "overlay")!;
    const extra = [1, 2, 3].map((index) => ({ ...overlay, id: `O${index + 1}` }));
    const pane = await mountPane({ ...document, tracks: [...document.tracks, ...extra] });
    await using _screen = pane.screen;
    pane.scroller.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: pane.scroller.getBoundingClientRect().left + 400,
        deltaY: -600,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(pane.scroller.scrollWidth).toBeGreaterThan(pane.scroller.clientWidth * 2),
    );
    expect(pane.scroller.scrollHeight).toBeGreaterThan(pane.scroller.clientHeight);
    const left = pane.scroller.scrollLeft;
    // At the top, a wheel down is left to the browser, which scrolls the rows.
    expect(wheel(pane.scroller, 120)).toBe(true);
    expect(pane.scroller.scrollLeft).toBe(left);
    // At the bottom it scrolls sideways.
    pane.scroller.scrollTop = pane.scroller.scrollHeight;
    await vi.waitFor(() => expect(pane.scroller.scrollTop).toBeGreaterThan(0));
    pane.scroller.dispatchEvent(new Event("scroll"));
    expect(wheel(pane.scroller, 120)).toBe(false);
    await vi.waitFor(() => expect(pane.scroller.scrollLeft).toBe(left + 120));
  });
});
