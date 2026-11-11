// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-075: the caption overlay shows the still of the chunk at the player's frame, on the frame
 * the chunk starts and not after it ends, inside the canvas; nothing for a clip or a version.
 * Stills are drawn here with a canvas and served by a mocked asset route (S7V-079);
 * `test_captions.py` and the goldens cover the real ones.
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

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePreparedConnection: () =>
    ({ _tag: "Some", value: { httpBaseUrl: "http://127.0.0.1:3773/" } }) as never,
}));

const STILLS_URL = "/api/assets/payload.signature/";
/** The mocked asset route: each still's PNG by file name, and every path asked for. */
const route = {
  pngs: new Map<string, Blob>(),
  requests: [] as string[],
  hold: null as Promise<void> | null,
  /** A new look per test, so no test sees stills an earlier one loaded. */
  folder: "",
};

let looks = 0;
/** Serves the stills from `route` for one test: `using _route = mockRoute()`. */
function mockRoute(): Disposable {
  route.pngs.clear();
  route.requests = [];
  route.hold = null;
  route.folder = `look-${(looks += 1)}`;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    route.requests.push(url.pathname);
    await route.hold;
    const png = route.pngs.get(url.pathname.slice(STILLS_URL.length));
    return png === undefined ? new Response(null, { status: 404 }) : new Response(png);
  });
  return { [Symbol.dispose]: () => fetchSpy.mockRestore() };
}

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
async function still(text: string, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  const size = Math.round(Math.min(width, height) * 0.075);
  context.font = `bold ${size}px sans-serif`;
  context.textAlign = "center";
  context.fillStyle = "#000";
  context.fillText(text, width / 2 + size * 0.06, height * 0.72 + size * 0.06);
  context.fillStyle = "#fff";
  context.fillText(text, width / 2, height * 0.72);
  return canvas.convertToBlob({ type: "image/png" });
}

/** A reply naming one still per text, each served by the mocked route. */
async function stillsFor(
  width: number,
  height: number,
  texts: ReadonlyArray<string> = ["Hello there", "from the edit"],
): Promise<CaptionStillsResult> {
  const names = texts.map((text) => `${text.replaceAll(" ", "-")}-${width}x${height}.png`);
  for (const [index, text] of texts.entries()) {
    route.pngs.set(names[index]!, await still(text, width, height));
  }
  return {
    key: `k-${width}x${height}-${texts.join("|")}`,
    width,
    height,
    chunks: [
      { start: 0, end: 15, still: 0 },
      { start: 20, end: 35, still: 1 },
      { start: 35, end: 50, still: 0 },
    ],
    folder: route.folder,
    stillsUrl: STILLS_URL,
    stills: names,
    missing: [],
  };
}

async function mountPlayer(width: number, height: number, updating = false) {
  stills.state = { _tag: "ready", stills: await stillsFor(width, height), updating };
  return renderPlayer(width, height);
}

function renderPlayer(width: number, height: number) {
  return render(player(width, height), { router: false });
}

function player(width: number, height: number) {
  const plan = editPlaybackPlan(documentOf(width, height))!;
  return (
    <EditPlayer
      projectKey={projectKey}
      src=""
      label="cam.mp4"
      plan={plan}
      startFrame={0}
      onPositionChange={() => {}}
      onError={() => {}}
      overlay={<CaptionOverlay projectRef={projectRef} />}
    />
  );
}

const overlay = () => document.querySelector<HTMLImageElement>("[data-testid=caption-overlay]")!;
const frame = async (value: number) => {
  publishPlayerFrame(projectKey, value);
  await act(async () => {});
};
/** Waits until the overlay shows the stills of the reply in `stills.state`. */
const loaded = () =>
  expect
    .poll(() => document.querySelector("[role=status]")?.textContent ?? "")
    .not.toContain("Updating captions");

describe("CaptionOverlay", () => {
  it("shows the chunk at the frame, on its first frame and not on its end frame", async () => {
    using _route = mockRoute();
    await using _screen = await mountPlayer(1080, 1920);
    await loaded();
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
    using _route = mockRoute();
    await using _screen = await mountPlayer(1080, 1920);
    await loaded();
    await frame(5);
    const canvas = document.querySelector<HTMLElement>("[data-canvas]")!.getBoundingClientRect();
    const image = overlay().getBoundingClientRect();
    expect(Math.round(image.width)).toBe(Math.round(canvas.width));
    expect(Math.round(image.height)).toBe(Math.round(canvas.height));
    expect(Math.round(image.left)).toBe(Math.round(canvas.left));
  });

  it("shows nothing while a clip or a saved version plays", async () => {
    using _route = mockRoute();
    await using _screen = await mountPlayer(1080, 1920);
    await act(async () =>
      useEditPlayerStore.getState().setSource(projectKey, { kind: "clip", mediaId: "cam" }),
    );
    expect(document.querySelector("[data-testid=caption-overlay]")).toBeNull();
    await act(async () => useEditPlayerStore.getState().setSource(projectKey, { kind: "edit" }));
    expect(document.querySelector("[data-testid=caption-overlay]")).not.toBeNull();
  });

  it("keeps the previous captions while new ones are drawn, with a note", async () => {
    using _route = mockRoute();
    await using screen = await mountPlayer(1080, 1920, true);
    await expect.poll(() => overlay().src).toMatch(/^blob:/);
    await frame(5);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Updating captions…");
    expect(overlay().hidden).toBe(false);
  });

  it("S7V-079: a changed chunk fetches only its new still, keeping the old one meanwhile", async () => {
    using _route = mockRoute();
    await using screen = await mountPlayer(1080, 1920);
    await loaded();
    await frame(5);
    const before = overlay().src;
    expect(route.requests).toHaveLength(2);
    expect(new Set(route.requests).size).toBe(2);

    let release = () => {};
    route.hold = new Promise((resolve) => (release = resolve));
    const cut = await stillsFor(1080, 1920, ["Hello there", "after the cut"]);
    stills.state = { _tag: "ready", stills: cut, updating: false };
    await screen.rerender(player(1080, 1920));
    // The new still is on its way: the old captions stay, with the note.
    await expect.element(screen.getByRole("status")).toHaveTextContent("Updating captions…");
    await frame(25);
    expect(overlay().hidden).toBe(false);
    const oldSecond = overlay().src;
    release();
    await loaded();
    expect(route.requests).toEqual([
      `${STILLS_URL}Hello-there-1080x1920.png`,
      `${STILLS_URL}from-the-edit-1080x1920.png`,
      `${STILLS_URL}after-the-cut-1080x1920.png`,
    ]);
    await frame(5);
    expect(overlay().src).toBe(before);
    await frame(25);
    expect(overlay().src).not.toBe(oldSecond);
  });

  it("S7V-079: a remount with every still cached shows them at once, with no note", async () => {
    using _route = mockRoute();
    {
      await using _first = await mountPlayer(1080, 1920);
      await loaded();
    }
    expect(route.requests).toHaveLength(2);
    publishPlayerFrame(projectKey, 5);
    // Records every note ever added, even one removed again before the render settles.
    const container = document.createElement("div");
    const notes: string[] = [];
    const collect = (records: ReadonlyArray<MutationRecord>) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.textContent?.includes("Updating captions")) {
            notes.push(node.textContent);
          }
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(container, { childList: true, subtree: true });
    await using _again = await render(player(1080, 1920), { container, router: false });
    collect(observer.takeRecords());
    observer.disconnect();
    expect(notes).toEqual([]);
    expect(overlay().hidden).toBe(false);
    expect(overlay().src).toMatch(/^blob:/);
    expect(route.requests).toHaveLength(2);
  });

  it("hides a chunk whose still can't be fetched", async () => {
    using _route = mockRoute();
    stills.state = {
      _tag: "ready",
      stills: await stillsFor(1080, 1920, ["one", "two"]),
      updating: false,
    };
    route.pngs.delete("two-1080x1920.png");
    await using _screen = await renderPlayer(1080, 1920);
    await loaded();
    await frame(5);
    expect(overlay().hidden).toBe(false);
    await frame(25);
    expect(overlay().hidden).toBe(true);
  });

  it("names a clip whose transcript can't be read", async () => {
    using _route = mockRoute();
    stills.state = {
      _tag: "ready",
      stills: { ...(await stillsFor(1080, 1920)), missing: ["interview.mov"] },
      updating: false,
    };
    await using screen = await renderPlayer(1080, 1920);
    await loaded();
    const note = await screen.getByRole("status").findElement();
    expect(note.textContent).toBe(
      "No transcript for interview.mov: its captions can't follow your cuts. Transcribe it again.",
    );
  });

  it.each([
    ["9x16", 1080, 1920, "dark", 1440],
    ["16x9", 1920, 1080, "dark", 1440],
    ["9x16", 1080, 1920, "light", 1440],
    ["16x9", 1920, 1080, "light", 1440],
    ["9x16-min", 1080, 1920, "dark", 1180],
  ] as const)(
    "renders captions in the player at %s (%s)",
    async (name, width, height, theme, wide) => {
      using _route = mockRoute();
      await page.viewport(wide, wide === 1440 ? 900 : 760);
      document.documentElement.classList.toggle("dark", theme === "dark");
      await using _screen = await mountPlayer(width, height, name === "9x16" && theme === "dark");
      await expect.poll(() => overlay().src).toMatch(/^blob:/);
      await frame(5);
      await page.screenshot({ path: `${SHOTS}/player-${name}-${theme}.png` });
      expect(overlay().hidden).toBe(false);
    },
  );
});
