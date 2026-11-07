// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-034: gestures on the real timeline, with the edit RPCs mocked. A finished gesture sends one
 * batch; nothing is sent while the pointer moves; refused and stale gestures send nothing.
 */
import type { EditDocument, EditOp } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../../index.css";

import { act, fakeTimers, render } from "../../../../test/render";
import { Timeline, type TimelineEditing } from "./Timeline";
import { NUDGE_SETTLE_MS, type EditApplyOutcome, type TimelineNotice } from "./timelineEditor";

const LABELS_PX = 112;

const edit: EditDocument = {
  version: 1,
  fps: { num: 30, den: 1 },
  canvas: { width: 1080, height: 1920 },
  media: [
    {
      id: "cam",
      kind: "video",
      path: "assets/cam.mp4",
      fingerprint: { sha256: "ab".repeat(32), size: 10 },
      probe: { durationFrames: 3000, hasVideo: true, hasAudio: true },
    },
  ],
  tracks: [
    {
      kind: "video",
      id: "V1",
      items: [
        { id: "v1", media: "cam", start: 0, duration: 100, in: 0 },
        { id: "v2", media: "cam", start: 100, duration: 100, in: 300, linkId: "L" },
        { id: "v3", media: "cam", start: 300, duration: 100, in: 600 },
      ],
    },
    {
      kind: "sfx",
      id: "S1",
      items: [{ id: "s1", media: "cam", start: 100, duration: 100, in: 300, linkId: "L" }],
    },
  ],
  markers: [],
  metadata: {},
};

interface Harness {
  readonly apply: ReturnType<
    typeof vi.fn<(ops: ReadonlyArray<EditOp>, base: number) => Promise<EditApplyOutcome>>
  >;
  readonly undo: ReturnType<typeof vi.fn>;
  readonly redo: ReturnType<typeof vi.fn>;
  readonly notify: ReturnType<typeof vi.fn<(notice: TimelineNotice) => void>>;
}

async function mount(options: { initialFrame?: number; reply?: EditApplyOutcome } = {}) {
  await page.viewport(1_280, 800);
  const container = window.document.createElement("div");
  container.style.cssText = "width: 1112px; height: 300px;";
  const harness: Harness = {
    apply: vi.fn(async () => options.reply ?? { _tag: "applied", revision: 8 }),
    undo: vi.fn(async () => ({ _tag: "applied", revision: 9 }) as const),
    redo: vi.fn(async () => ({ _tag: "applied", revision: 10 }) as const),
    notify: vi.fn(),
  };
  const editing = (revision: number): TimelineEditing => ({
    revision,
    canUndo: true,
    canRedo: true,
    actions: {
      apply: harness.apply,
      undo: harness.undo,
      redo: harness.redo,
      notify: harness.notify,
    },
  });
  const actions = editing(7).actions;
  const ui = (document: EditDocument, revision: number) => (
    <Timeline
      projectKey="env-1:project-edit"
      document={document}
      playheadVisible
      initialFrame={options.initialFrame ?? 0}
      onSeek={() => {}}
      editing={{ ...editing(revision), actions }}
    />
  );
  const screen = await render(ui(edit, 7), { container, router: false });
  const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
  const ppf = () => Number(scroller.dataset.pxPerFrame);
  const block = (id: string) =>
    container.querySelector<HTMLElement>(`[data-timeline-item="${id}"]`)!;
  const xOf = (frame: number) =>
    scroller.getBoundingClientRect().left + LABELS_PX + frame * ppf() - scroller.scrollLeft;
  const yOf = (id: string) => {
    const rect = block(id).getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const pointer = (
    type: string,
    target: EventTarget,
    x: number,
    y: number,
    init: PointerEventInit = {},
  ) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  /** Presses at frame `from` on `id`, moves in `steps` to frame `to`, and releases. */
  const drag = async (
    id: string,
    from: number,
    to: number,
    steps = 100,
    init: PointerEventInit = {},
    y?: number,
  ) => {
    const startY = yOf(id);
    pointer("pointerdown", block(id), xOf(from), startY, init);
    for (let step = 1; step <= steps; step++) {
      const frame = from + ((to - from) * step) / steps;
      pointer("pointermove", window.document, xOf(frame), y ?? startY, init);
    }
    expect(harness.apply).not.toHaveBeenCalled();
    pointer("pointerup", window.document, xOf(to), y ?? startY, init);
    await act(async () => {});
  };
  const key = async (keyName: string, init: KeyboardEventInit = {}) => {
    scroller.dispatchEvent(
      new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }),
    );
    await act(async () => {});
  };
  return { screen, container, scroller, harness, ui, block, xOf, yOf, pointer, drag, key };
}

describe("Timeline editing (S7V-034)", () => {
  it("sends one batch for a 100-step drag, and none while the pointer moves", async () => {
    const view = await mount();
    await using _screen = view.screen;
    await view.drag("v3", 350, 470, 100, { metaKey: true });
    expect(view.harness.apply).toHaveBeenCalledTimes(1);
    expect(view.harness.apply).toHaveBeenCalledWith(
      [{ _tag: "moveItem", itemId: "v3", start: 420 }],
      7,
    );
  });

  it("moves a linked pair as one op; the server carries the linked item", async () => {
    const view = await mount();
    await using _screen = view.screen;
    await view.drag("v2", 150, 200, 20, { metaKey: true });
    expect(view.harness.apply).toHaveBeenCalledWith(
      [{ _tag: "moveItem", itemId: "v2", start: 150 }],
      7,
    );
  });

  it("trims from a clip's edge", async () => {
    const view = await mount();
    await using _screen = view.screen;
    // Pressed just inside v3's right edge.
    await view.drag("v3", 399.6, 350, 10, { metaKey: true });
    expect(view.harness.apply).toHaveBeenCalledWith(
      [{ _tag: "trimItem", itemId: "v3", edge: "end", frame: 350 }],
      7,
    );
  });

  it("refuses a move onto another clip: nothing is sent and the clip shows blocked", async () => {
    const view = await mount();
    await using _screen = view.screen;
    const startY = view.yOf("v3");
    view.pointer("pointerdown", view.block("v3"), view.xOf(350), startY, { metaKey: true });
    view.pointer("pointermove", window.document, view.xOf(150), startY, { metaKey: true });
    const ghost = view.container.querySelector<HTMLElement>('[data-timeline-ghost="v3"]')!;
    expect(ghost.dataset.blocked).toBe("true");
    view.pointer("pointerup", window.document, view.xOf(150), startY, { metaKey: true });
    await act(async () => {});
    expect(view.harness.apply).not.toHaveBeenCalled();
    expect(view.block("v3").dataset.blocked).toBe("true");
    expect(Number(view.block("v3").dataset.start)).toBe(300);
    expect(view.container.querySelector("[data-timeline-ghost]")).toBeNull();
  });

  it("refuses a video clip dragged onto the sound effects track", async () => {
    const view = await mount();
    await using _screen = view.screen;
    await view.drag("v3", 350, 352, 10, { metaKey: true }, view.yOf("s1"));
    expect(view.harness.apply).not.toHaveBeenCalled();
  });

  it("snaps the dragged edge onto the playhead within 8 px, and not while cmd is held", async () => {
    const view = await mount({ initialFrame: 260 });
    await using _screen = view.screen;
    const ppf = Number(view.scroller.dataset.pxPerFrame);
    // v3's start edge dropped 6 px before the playhead lands on it.
    const off = 6 / ppf;
    await view.drag("v3", 350, 350 - 40 - off, 30);
    expect(view.harness.apply).toHaveBeenLastCalledWith(
      [{ _tag: "moveItem", itemId: "v3", start: 260 }],
      7,
    );
    const loose = await mount({ initialFrame: 260 });
    await using _loose = loose.screen;
    await loose.drag("v3", 350, 350 - 40 - off, 30, { metaKey: true });
    expect(loose.harness.apply).toHaveBeenLastCalledWith(
      [{ _tag: "moveItem", itemId: "v3", start: Math.round(260 - off) }],
      7,
    );
  });

  it("cancels a drag when the assistant's edit lands mid-gesture, and sends nothing", async () => {
    const view = await mount();
    await using _screen = view.screen;
    const startY = view.yOf("v3");
    view.pointer("pointerdown", view.block("v3"), view.xOf(350), startY, { metaKey: true });
    view.pointer("pointermove", window.document, view.xOf(450), startY, { metaKey: true });
    expect(view.container.querySelector('[data-timeline-ghost="v3"]')).not.toBeNull();
    await view.screen.rerender(view.ui(edit, 8));
    expect(view.harness.notify).toHaveBeenCalledWith({ kind: "changed-elsewhere" });
    expect(view.container.querySelector("[data-timeline-ghost]")).toBeNull();
    view.pointer("pointerup", window.document, view.xOf(450), startY, { metaKey: true });
    await act(async () => {});
    expect(view.harness.apply).not.toHaveBeenCalled();
  });

  it("tells the user to try again when the server reports a stale revision", async () => {
    const view = await mount({ reply: { _tag: "conflict" } });
    await using _screen = view.screen;
    await view.drag("v3", 350, 450, 10, { metaKey: true });
    expect(view.harness.notify).toHaveBeenCalledWith({ kind: "changed-elsewhere" });
    expect(view.container.querySelector("[data-timeline-ghost]")).toBeNull();
  });

  it("splits, deletes, ripple deletes, undoes and redoes from the keyboard", async () => {
    const view = await mount({ initialFrame: 40 });
    await using _screen = view.screen;
    await view.key("s");
    expect(view.harness.apply).toHaveBeenLastCalledWith(
      [{ _tag: "splitItem", itemId: "v1", atFrame: 40 }],
      7,
    );
    // Selecting v3 (a click) then Delete leaves a gap; shift+Delete closes it.
    view.pointer("pointerdown", view.block("v3"), view.xOf(350), view.yOf("v3"));
    view.pointer("pointerup", window.document, view.xOf(350), view.yOf("v3"));
    await act(async () => {});
    expect(view.block("v3").dataset.selected).toBe("true");
    await view.screen.rerender(view.ui(edit, 8));
    await view.key("Delete");
    expect(view.harness.apply).toHaveBeenLastCalledWith(
      [{ _tag: "deleteItem", itemIds: ["v3"], ripple: false }],
      8,
    );
    view.pointer("pointerdown", view.block("v1"), view.xOf(50), view.yOf("v1"));
    view.pointer("pointerup", window.document, view.xOf(50), view.yOf("v1"));
    await act(async () => {});
    await view.key("Delete", { shiftKey: true });
    expect(view.harness.apply).toHaveBeenLastCalledWith(
      [{ _tag: "deleteItem", itemIds: ["v1"], ripple: true }],
      8,
    );
    await view.key("z", { metaKey: true });
    expect(view.harness.undo).toHaveBeenCalledTimes(1);
    await view.key("z", { metaKey: true, shiftKey: true });
    expect(view.harness.redo).toHaveBeenCalledTimes(1);
  });

  it("makes one move of a burst of arrow nudges", async () => {
    const view = await mount();
    using _timers = fakeTimers();
    await using _screen = view.screen;
    view.pointer("pointerdown", view.block("v3"), view.xOf(350), view.yOf("v3"));
    view.pointer("pointerup", window.document, view.xOf(350), view.yOf("v3"));
    await act(async () => {});
    for (let index = 0; index < 4; index++) await view.key("ArrowRight");
    await view.key("ArrowLeft");
    await view.key("ArrowRight", { shiftKey: true });
    expect(view.harness.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NUDGE_SETTLE_MS);
    expect(view.harness.apply).toHaveBeenCalledTimes(1);
    expect(view.harness.apply).toHaveBeenCalledWith(
      [{ _tag: "moveItem", itemId: "v3", start: 333 }],
      7,
    );
  });
});
