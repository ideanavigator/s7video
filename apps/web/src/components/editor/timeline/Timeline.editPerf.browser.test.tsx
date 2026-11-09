// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-034 AC-8: dragging and trimming a clip of the generated 1,000-clip edit runs no main-thread
 * task over 50 ms. The pointer moves once per animation frame, as a real drag delivers it.
 */
import type { EditOp } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import { nextPaint } from "../../../../test/framePacing";
import { act, render } from "../../../../test/render";

import "../../../index.css";

import { brandThemeTokenVariables } from "../../../themePalette";
import { Timeline } from "./Timeline";

const edit = makePerfEdit(1_000);
const MOVES = 120;

describe("Timeline editing performance (1,000 clips)", () => {
  it("drags and trims with no long task", async () => {
    await page.viewport(1_200, 600);
    for (const [name, value] of Object.entries(brandThemeTokenVariables("dark"))) {
      document.documentElement.style.setProperty(name, value);
    }
    const container = document.createElement("div");
    container.style.cssText = "width: 1112px; height: 280px;";
    const apply = vi.fn(
      async (_ops: ReadonlyArray<EditOp>) => ({ _tag: "applied", revision: 2 }) as const,
    );
    await using _screen = await render(
      <Timeline
        projectKey="env-perf:project-edit"
        document={edit}
        playheadVisible
        initialFrame={0}
        onSeek={() => {}}
        editing={{
          revision: 1,
          canUndo: false,
          canRedo: false,
          actions: {
            apply,
            undo: async () => ({ _tag: "nothing" }),
            redo: async () => ({ _tag: "nothing" }),
            notify: () => {},
          },
        }}
      />,
      { container, router: false },
    );
    // Zoom in (the + key, 1.5x a press) so clips are wide enough to grab in the middle and edge.
    const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
    for (let press = 0; press < 8; press++) {
      scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    }
    await act(async () => {});
    await nextPaint();
    const clips = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-timeline-row="video"] [data-timeline-item]',
      ),
    ];
    const target = clips.find((clip) => clip.getBoundingClientRect().width > 40)!;
    expect(target).toBeDefined();
    await nextPaint();

    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: false });

    const pointer = (type: string, on: EventTarget, x: number, y: number) =>
      on.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }),
      );
    const gesture = async (fromX: number, y: number, distance: number) => {
      pointer("pointerdown", target, fromX, y);
      for (let step = 1; step <= MOVES; step++) {
        await nextPaint();
        pointer("pointermove", document, fromX + (distance * step) / MOVES, y);
      }
      pointer("pointerup", document, fromX + distance, y);
      await act(async () => {});
      await nextPaint();
    };
    const rect = target.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    // Drag: from the middle, back and forth across neighbours (blocked and free states).
    await gesture(rect.left + rect.width / 2, y, 200);
    // Trim: the right edge, inwards.
    const after = target.getBoundingClientRect();
    await gesture(after.right - 2, y, -after.width / 3);
    await nextPaint();
    observer.disconnect();

    console.info(
      `S7V-034 edit perf: ${JSON.stringify({ longTasks, applies: apply.mock.calls.length })}`,
    );
    expect(longTasks.filter((duration) => duration > 50)).toEqual([]);
    // Each finished gesture is at most one batch (a refused drag sends none).
    expect(apply.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
