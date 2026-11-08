// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-075: the caption overlay shows the still of the chunk at the player's frame, on the frame
 * the chunk starts and not after it ends, inside the canvas; nothing for a clip or a version.
 * Stills are drawn here with a canvas; `test_captions.py` and the goldens cover the real ones.
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  type CaptionStillsResult,
  type EditDocument,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { editPlaybackPlan } from "../../editor/editPlayback";
import {
  type CaptionStillsState,
  publishPlayerFrame,
  useEditPlayerStore,
} from "../../editor/editStore";
import { CaptionOverlay } from "./CaptionOverlay";
import { EditPlayer } from "./EditPlayer";

const stills = vi.hoisted(() => ({ state: { _tag: "none" } as CaptionStillsState }));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useCaptionStills: () => stills.state,
}));

const projectRef = { environmentId: EnvironmentId.make("env-1"), projectId: ProjectId.make("p1") };
const projectKey = scopedProjectKey(projectRef);
/** Screenshots for the UX review land in the repo's ignored test-results folder. */
const SHOTS = "../../../../../test-results/S7V-075";

const documentOf = (width: number, height: number): EditDocument => ({
  version: 1,
  fps: { num: 30, den: 1 },
  canvas: { width, height },
  media: [
    {
      id: "cam",
      kind: "video",
      path: "assets/cam.mp4",
      fingerprint: { sha256: "ab".repeat(32), size: 10 },
      probe: { durationFrames: 300, hasVideo: true, hasAudio: true },
    },
  ],
  tracks: [
    {
      kind: "video",
      id: "V1",
      items: [{ id: "v1", media: "cam", start: 0, duration: 300, in: 0 }],
    },
  ],
  markers: [],
  metadata: {},
});

/** A caption still as the engine draws it: the whole canvas, transparent, bold text near the bottom. */
async function still(text: string, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  const size = Math.round(Math.min(width, height) * 0.075);
  context.font = `bold ${size}px sans-serif`;
  context.textAlign = "center";
  context.fillStyle = "#000";
  context.fillText(text, width / 2 + size * 0.06, height * 0.72 + size * 0.06);
  context.fillStyle = "#fff";
  context.fillText(text, width / 2, height * 0.72);
  const bytes = new Uint8Array(
    await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function stillsFor(width: number, height: number): Promise<CaptionStillsResult> {
  return {
    key: `k-${width}x${height}`,
    width,
    height,
    chunks: [
      { start: 0, end: 15, still: 0 },
      { start: 20, end: 35, still: 1 },
      { start: 35, end: 50, still: 0 },
    ],
    stills: [
      await still("Hello there", width, height),
      await still("from the edit", width, height),
    ],
  };
}

async function mountPlayer(width: number, height: number, updating = false) {
  stills.state = { _tag: "ready", stills: await stillsFor(width, height), updating };
  const plan = editPlaybackPlan(documentOf(width, height))!;
  return render(
    <EditPlayer
      projectKey={projectKey}
      src=""
      label="cam.mp4"
      plan={plan}
      startFrame={0}
      onPositionChange={() => {}}
      onError={() => {}}
      overlay={<CaptionOverlay projectRef={projectRef} />}
    />,
    { router: false },
  );
}

const overlay = () => document.querySelector<HTMLImageElement>("[data-testid=caption-overlay]")!;
const frame = async (value: number) => {
  publishPlayerFrame(projectKey, value);
  await act(async () => {});
};

describe("CaptionOverlay", () => {
  it("shows the chunk at the frame, on its first frame and not on its end frame", async () => {
    await using _screen = await mountPlayer(1080, 1920);
    const image = overlay();
    expect(image.getAttribute("aria-hidden")).toBe("true");
    await frame(0);
    expect(image.hidden).toBe(false);
    const first = image.src;
    await frame(14);
    expect(image.src).toBe(first);
    await frame(15);
    expect(image.hidden).toBe(true);
    await frame(19);
    expect(image.hidden).toBe(true);
    await frame(20);
    expect(image.hidden).toBe(false);
    expect(image.src).not.toBe(first);
    await frame(35);
    expect(image.src).toBe(first);
    await frame(200);
    expect(image.hidden).toBe(true);
  });

  it("fills the canvas, not the 16:9 frame around it", async () => {
    await using _screen = await mountPlayer(1080, 1920);
    await frame(5);
    const canvas = document.querySelector<HTMLElement>("[data-canvas]")!.getBoundingClientRect();
    const image = overlay().getBoundingClientRect();
    expect(Math.round(image.width)).toBe(Math.round(canvas.width));
    expect(Math.round(image.height)).toBe(Math.round(canvas.height));
    expect(Math.round(image.left)).toBe(Math.round(canvas.left));
  });

  it("shows nothing while a clip or a saved version plays", async () => {
    await using _screen = await mountPlayer(1080, 1920);
    await act(async () =>
      useEditPlayerStore.getState().setSource(projectKey, { kind: "clip", mediaId: "cam" }),
    );
    expect(document.querySelector("[data-testid=caption-overlay]")).toBeNull();
    await act(async () => useEditPlayerStore.getState().setSource(projectKey, { kind: "edit" }));
    expect(document.querySelector("[data-testid=caption-overlay]")).not.toBeNull();
  });

  it("keeps the previous captions while new ones are drawn, with a note", async () => {
    await using screen = await mountPlayer(1080, 1920, true);
    await frame(5);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Updating captions…");
    expect(overlay().hidden).toBe(false);
  });

  it.each([
    ["9x16", 1080, 1920, "dark"],
    ["16x9", 1920, 1080, "dark"],
    ["9x16", 1080, 1920, "light"],
    ["16x9", 1920, 1080, "light"],
  ] as const)("renders captions in the player at %s (%s)", async (name, width, height, theme) => {
    await page.viewport(1440, 900);
    document.documentElement.classList.toggle("dark", theme === "dark");
    await using _screen = await mountPlayer(width, height, name === "9x16" && theme === "dark");
    await frame(5);
    await page.screenshot({ path: `${SHOTS}/player-${name}-${theme}.png` });
    expect(overlay().hidden).toBe(false);
  });
});
