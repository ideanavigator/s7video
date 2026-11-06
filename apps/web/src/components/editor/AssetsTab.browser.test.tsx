// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { type MediaAsset, type MediaLibrarySnapshot, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import type { MediaLibraryState } from "../../state/media";
import { AssetsList, type AssetsListProps } from "./AssetsTab";
import { ImportDialog } from "./ImportDialog";

const asset = (overrides: Partial<MediaAsset> & Pick<MediaAsset, "id">): MediaAsset => ({
  kind: "video",
  label: `${overrides.id}.mp4`,
  storage: "reference",
  location: `/Users/me/Movies/${overrides.id}.mp4`,
  state: "ready",
  sizeBytes: 2_208_029_958,
  durationFrames: 4_800,
  fps: { num: 30, den: 1 },
  width: 3840,
  height: 2160,
  hasVideo: true,
  hasAudio: true,
  hasThumbnail: true,
  proxy: { status: "none" },
  ...overrides,
});

const ready = (
  items: ReadonlyArray<MediaAsset>,
  importing: MediaLibrarySnapshot["importing"] = [],
): MediaLibraryState => ({
  _tag: "ready",
  snapshot: {
    projectId: ProjectId.make("project-1"),
    fps: { num: 30, den: 1 },
    items,
    importing,
  },
});

const sized = () => {
  const container = document.createElement("div");
  container.style.height = "480px";
  container.style.width = "640px";
  return container;
};

const renderList = (overrides: Partial<AssetsListProps>) => {
  const props: AssetsListProps = {
    state: ready([]),
    renderThumbnail: () => <span>thumb</span>,
    canAddFiles: true,
    onAddMedia: vi.fn(),
    onDropFiles: vi.fn(),
    onOpen: vi.fn(),
    onRelink: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  return {
    props,
    screen: render(<AssetsList {...props} />, { container: sized(), router: false }),
  };
};

/** Controls in an open dialog never settle for Playwright's stability check here; press them as the DOM does. */
const pressFooterButton = async (label: string) => {
  const element = await page.getByRole("button", { name: label, exact: true }).findElement();
  await act(() => (element as HTMLButtonElement).click());
};

describe("AssetsTab", () => {
  it("explains how to add clips when the project has none", async () => {
    const { props, screen: rendering } = renderList({});
    await using screen = await rendering;
    await expect
      .element(screen.getByText("Drop clips here or Add media.", { exact: false }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Add media" }).click();
    expect(props.onAddMedia).toHaveBeenCalledOnce();
  });

  it("cannot add files without the desktop app", async () => {
    const { screen: rendering } = renderList({ canAddFiles: false });
    await using screen = await rendering;
    await expect.element(screen.getByRole("button", { name: "Add media" })).toBeDisabled();
  });

  it("lists each clip with its length, resolution, size and how it is kept", async () => {
    const { screen: rendering } = renderList({
      state: ready([
        asset({ id: "big4k" }),
        asset({
          id: "whoosh",
          kind: "audio",
          label: "whoosh.wav",
          storage: "copy",
          location: "assets/whoosh.wav",
          sizeBytes: 200_000,
          durationFrames: 60,
          hasVideo: false,
          hasThumbnail: false,
          width: undefined as never,
          height: undefined as never,
        }),
      ]),
    });
    await using screen = await rendering;
    const big = screen.getByRole("listitem", {
      name: "big4k.mp4, length 2 minutes 40 seconds, ready",
    });
    await expect.element(big).toBeVisible();
    await expect.element(big.getByText("2:40 · 3840×2160 · 2.1 GB")).toBeVisible();
    await expect.element(big.getByText("Linked")).toBeVisible();
    // Audio has no frame rate of its own; it counts at the edit's rate.
    const sound = screen.getByRole("listitem", { name: "whoosh.wav, length 2 seconds, ready" });
    await expect.element(sound.getByText("0:02 · 195 KB")).toBeVisible();
    await expect.element(sound.getByText("Copy")).toBeVisible();
  });

  it("shows a preparing preview, a failed preview and a copy in progress", async () => {
    const { screen: rendering } = renderList({
      state: ready(
        [
          asset({ id: "phone", proxy: { status: "preparing", progress: 0.42 } }),
          asset({ id: "odd", proxy: { status: "failed" } }),
        ],
        [{ key: "copy-cam", label: "cam.mov", progress: 0.4 }],
      ),
    });
    await using screen = await rendering;
    await expect
      .element(screen.getByRole("listitem", { name: /phone\.mp4, .*, preparing preview$/u }))
      .toBeVisible();
    await expect.element(screen.getByText("Preparing preview 42%")).toBeVisible();
    await expect.element(screen.getByText("Preview failed")).toBeVisible();
    await expect.element(screen.getByRole("status").getByText("Copying cam.mov")).toBeVisible();
    await expect.element(screen.getByText("40%")).toBeVisible();
  });

  it("marks a moved original as missing with a Relink action", async () => {
    const moved = asset({ id: "moved", state: "missing" });
    const { props, screen: rendering } = renderList({ state: ready([moved]) });
    await using screen = await rendering;
    const row = screen.getByRole("listitem", { name: /moved\.mp4, .*, missing$/u });
    await expect.element(row.getByText("Missing")).toBeVisible();
    await row.getByRole("button", { name: "Relink" }).click();
    expect(props.onRelink).toHaveBeenCalledWith(moved);
  });

  it("opens a clip with Enter and asks to remove it with Delete", async () => {
    const clip = asset({ id: "cam" });
    const { props, screen: rendering } = renderList({ state: ready([clip]) });
    await using screen = await rendering;
    const row = screen.getByRole("listitem", { name: /^cam\.mp4/u });
    await expect.element(row).toBeVisible();
    await act(() => (row.element() as HTMLElement).focus());
    await userEvent.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenCalledWith(clip);
    await userEvent.keyboard("{Delete}");
    expect(props.onRemove).toHaveBeenCalledWith(clip);
  });

  it("hands dropped files to the importer", async () => {
    const { props, screen: rendering } = renderList({});
    await using screen = await rendering;
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = screen.getByText("No clips yet").element();
    await act(() => {
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    expect(props.onDropFiles).toHaveBeenCalledWith([file]);
  });

  describe("ImportDialog", () => {
    const plan = { suggestedMode: "copy" as const, totalBytes: 2_208_029_958, freeBytes: 900e9 };

    it("defaults to keeping a copy when there is room, and adds with the chosen mode", async () => {
      const onConfirm = vi.fn();
      await using _screen = await render(
        <ImportDialog
          request={{ paths: ["/Users/me/big4k.mp4"], plan }}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );
      await expect.element(page.getByText("Add a clip")).toBeVisible();
      await expect.element(page.getByText("big4k.mp4 (2.1 GB)", { exact: false })).toBeVisible();
      await expect.element(page.getByRole("radio", { name: /Keep a copy/u })).toBeChecked();
      const pointAtFile = await page.getByText("Use the file where it is").findElement();
      await act(() => (pointAtFile as HTMLElement).click());
      await expect
        .element(page.getByRole("radio", { name: /Use the file where it is/u }))
        .toBeChecked();
      await pressFooterButton("Add");
      expect(onConfirm).toHaveBeenCalledWith("reference");
    });

    it("does not default to copy when the disk is short, and says why", async () => {
      const onConfirm = vi.fn();
      const reason =
        "A copy needs 2.1 GB and should leave 15.0 GB free, but this Mac has 9.0 GB free.";
      await using _screen = await render(
        <ImportDialog
          request={{
            paths: ["/a.mp4", "/b.mp4", "/c.mp4", "/d.mp4"],
            plan: { suggestedMode: "reference", reason, totalBytes: 4e9, freeBytes: 9e9 },
          }}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );
      await expect.element(page.getByText("Add 4 clips")).toBeVisible();
      await expect
        .element(page.getByText("a.mp4, b.mp4, c.mp4 and 1 more", { exact: false }))
        .toBeVisible();
      await expect
        .element(page.getByRole("radio", { name: /Use the file where it is/u }))
        .toBeChecked();
      await expect.element(page.getByText(reason)).toBeVisible();
      await pressFooterButton("Add");
      expect(onConfirm).toHaveBeenCalledWith("reference");
    });
  });
});
