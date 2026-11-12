// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-037: the caption looks beside Export: each with its name and preview, the edit's look
 * marked, a pick sent once as one change, and a failed pick explained. The previews here are a
 * tiny stand-in PNG; `test_captions.py` and the `zoom-crop-presets` golden cover the real ones.
 */
import {
  CaptionsError,
  type CaptionPresetsResult,
  type EditDocument,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { CaptionStylePicker } from "./CaptionStylePicker";

/** A stand-in preview at the engine's size (240 px wide), drawn here: slate, with a white line. */
const previewPng = (box: boolean) => {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 52;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#5b6270";
  context.fillRect(0, 0, 240, 52);
  if (box) {
    context.fillStyle = "rgba(17, 19, 24, 0.72)";
    context.fillRect(60, 10, 120, 32);
  }
  context.fillStyle = "#ffffff";
  context.font = "bold 22px sans-serif";
  context.textAlign = "center";
  context.fillText("Say it loud", 120, 34);
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
};

const state = vi.hoisted(() => ({ presets: null as CaptionPresetsResult | null }));
const commands = vi.hoisted(() => ({
  setStyle: vi.fn(async (_input: unknown): Promise<unknown> => ({
    _tag: "Success",
    value: { revision: 2, added: false, changed: true },
  })),
}));
const toasts = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useCaptionPresets: () => state.presets,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => commands.setStyle) as never,
}));
vi.mock(import("../ui/toast"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, toastManager: { ...actual.toastManager, add: toasts.add } };
});

const projectRef = {
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
};
/** Screenshots for the UX review land in the repo's ignored test-results folder. */
const SHOTS = "../../../../../test-results/caption-presets";

const documentWith = (style?: string): EditDocument => ({
  version: 1,
  fps: { num: 30, den: 1 },
  canvas: { width: 1080, height: 1920 },
  media: [],
  tracks: [
    { kind: "video", id: "V1", items: [] },
    ...(style === undefined
      ? []
      : [
          {
            kind: "caption" as const,
            id: "C1",
            style,
            items: [{ id: "c1", start: 0, duration: 30, text: "hello there" }],
          },
        ]),
  ],
  markers: [],
  metadata: {},
});

const allPreviews = (): CaptionPresetsResult => ({
  presets: [
    { id: "s7-neutral", name: "Plain", png: previewPng(false) },
    { id: "s7-box", name: "Boxed", png: previewPng(true) },
    { id: "s7-karaoke", name: "Highlighted word", png: previewPng(false) },
    { id: "s7-minimal", name: "Minimal", png: "" },
  ],
});

const mount = (document: EditDocument) =>
  render(
    <div className="flex p-4">
      <CaptionStylePicker projectRef={projectRef} document={document} />
    </div>,
  );

describe("CaptionStylePicker (S7V-037)", () => {
  it("shows each look by name, with its preview, and marks the edit's look", async () => {
    state.presets = allPreviews();
    await using screen = await mount(documentWith("s7-box"));
    const names = ["Plain", "Boxed", "Highlighted word", "Minimal"];
    for (const name of names) {
      await expect
        .element(screen.getByRole("button", { name: `Caption style: ${name}` }))
        .toBeVisible();
      await expect.element(screen.getByText(name, { exact: true })).toBeVisible();
    }
    await expect
      .element(screen.getByRole("button", { name: "Caption style: Boxed" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: "Caption style: Plain" }))
      .toHaveAttribute("aria-pressed", "false");
    // A preview that couldn't be drawn shows the name only.
    const images = (name: string) =>
      screen
        .getByRole("button", { name: `Caption style: ${name}` })
        .element()
        .querySelectorAll("img");
    expect(images("Boxed")).toHaveLength(1);
    expect(images("Minimal")).toHaveLength(0);
  });

  it("before the previews arrive, and with no captions yet, still offers every look", async () => {
    state.presets = null;
    await using screen = await mount(documentWith());
    await expect
      .element(screen.getByRole("button", { name: "Caption style: Plain" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("sends one pick, by keyboard too, and nothing for the look already used", async () => {
    state.presets = allPreviews();
    commands.setStyle.mockClear();
    await using screen = await mount(documentWith("s7-box"));
    await screen.getByRole("button", { name: "Caption style: Boxed" }).click();
    expect(commands.setStyle).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Caption style: Minimal" }).click();
    expect(commands.setStyle).toHaveBeenCalledWith({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId, preset: "s7-minimal" },
    });
    screen.getByRole("button", { name: "Caption style: Highlighted word" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => commands.setStyle.mock.calls.length).toBe(2);
    expect(commands.setStyle.mock.calls[1]![0]).toMatchObject({ input: { preset: "s7-karaoke" } });
  });

  it("explains a pick that can't add captions", async () => {
    state.presets = allPreviews();
    toasts.add.mockClear();
    const detail = "Transcribe the clip first: cam has no transcript.";
    commands.setStyle.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new CaptionsError({ reason: "no-transcript", detail })),
    });
    await using screen = await mount(documentWith());
    await screen.getByRole("button", { name: "Caption style: Boxed" }).click();
    await expect.poll(() => toasts.add.mock.calls.length).toBe(1);
    expect(toasts.add.mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Couldn't change the caption look",
      description: detail,
    });
  });

  it.each(["light", "dark"] as const)("renders the looks for the UX review (%s)", async (theme) => {
    state.presets = allPreviews();
    await page.viewport(1440, 900);
    document.documentElement.classList.toggle("dark", theme === "dark");
    await using _screen = await mount(documentWith("s7-karaoke"));
    await page.screenshot({ path: `${SHOTS}/strip-${theme}.png` });
    document.documentElement.classList.remove("dark");
  });
});
