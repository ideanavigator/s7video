// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The S7V-035 seam: a stand-in for `ClipMediaTiles` mounted in `ClipMediaSlot` gets the project,
 * the media asset and the item as props, and the pixel span from `subscribeView`, outside React.
 */
import type { EditDocument, MediaAsset } from "@t3tools/contracts";
import { use, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../../index.css";

import { makePerfEdit } from "../../../../test/fixtures/timeline/perfEdit";
import { render } from "../../../../test/render";
import type { ClipMediaSlotProps } from "./ClipMediaSlot";
import { clipSpanInView, TimelineViewContext, type ClipSpan } from "./timelineView";

const seen = vi.hoisted(() => ({
  props: new Map<string, ClipMediaSlotProps>(),
  spans: new Map<string, ClipSpan>(),
  renders: 0,
}));

vi.mock(import("./ClipMediaSlot"), () => ({
  ClipMediaSlot: (props: ClipMediaSlotProps) => {
    seen.renders += 1;
    seen.props.set(props.item.id, props);
    const source = use(TimelineViewContext);
    useEffect(() => {
      if (source === null) return;
      const update = () =>
        seen.spans.set(props.item.id, clipSpanInView(props.item, source.getView()));
      update();
      return source.subscribeView(update);
    }, [source, props.item]);
    return null;
  },
}));

import { Timeline } from "./Timeline";

const asset = { id: "synth", kind: "video", label: "testsrc2.mp4" } as unknown as MediaAsset;

describe("ClipMediaSlot seam", () => {
  it("passes ids and the asset, and publishes zoom and scroll outside React", async () => {
    await page.viewport(1_280, 800);
    const container = document.createElement("div");
    container.style.cssText = "width:1112px;height:260px";
    const document_: EditDocument = makePerfEdit(300);
    await using _screen = await render(
      <Timeline
        projectKey="env-1:project-1"
        document={document_}
        playheadVisible
        initialFrame={0}
        onSeek={() => {}}
        projectRef={{ environmentId: "env-1" as never, projectId: "project-1" as never }}
        mediaById={new Map([["synth", asset]])}
      />,
      { container, router: false },
    );
    const scroller = container.querySelector<HTMLDivElement>("[data-testid=timeline-scroller]")!;
    await vi.waitFor(() => expect(seen.props.size).toBeGreaterThan(0));
    const [id, props] = [...seen.props.entries()][0]!;
    expect(props).toMatchObject({ environmentId: "env-1", projectId: "project-1", asset });
    // Text items (captions, overlays) show no project media, so they get no slot.
    expect([...seen.props.values()].every((entry) => entry.item.mediaId === "synth")).toBe(true);

    // Zoom in: the span follows at once, and the mounted slots do not re-render per step.
    const rendersBefore = seen.renders;
    const scaleOf = (span: ClipSpan) => span.widthPx / Math.max(1, span.endFrame - span.firstFrame);
    const scaleBefore = scaleOf(seen.spans.get(id)!);
    scroller.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: scroller.getBoundingClientRect().left + 140,
        deltaY: -200,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(scaleOf(seen.spans.get(id)!)).toBeGreaterThan(scaleBefore * 1.5));
    expect(Number(scroller.dataset.viewEnd)).toBeGreaterThan(Number(scroller.dataset.viewStart));
    expect(seen.renders).toBe(rendersBefore);
  });
});
