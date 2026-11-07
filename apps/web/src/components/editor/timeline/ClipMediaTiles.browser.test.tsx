// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EnvironmentId,
  type AssetResource,
  type MediaDataState,
  ProjectId,
} from "@t3tools/contracts";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  filmstripIndex,
  levelBytes,
  makeMediaDataServer,
  peaksIndex,
  sheetCanvas,
  stripLevel,
} from "../../../../test/fixtures/timeline/mediaData";
import { render } from "../../../../test/render";
import { drawFilmstrip, drawWaveform } from "./mediaTilesDraw";
import type { ClipView } from "./mediaTilesProtocol";

const serve = makeMediaDataServer();
const minted: AssetResource[] = [];
const refreshed: AssetResource[] = [];
/** Media whose first URL for each part is dead, as an expired token would be. */
const STALE_MEDIA = "stale";
const deadUrl = (() => {
  const url = URL.createObjectURL(new Blob(["gone"]));
  URL.revokeObjectURL(url);
  return url;
})();
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlMinter:
    () => async (resource: AssetResource, options?: { readonly refresh?: boolean }) => {
      minted.push(resource);
      if (options?.refresh === true) refreshed.push(resource);
      const stale =
        resource._tag === "project-media" && resource.mediaId === STALE_MEDIA && !options?.refresh;
      return stale ? deadUrl : ((await serve(resource)) ?? null);
    },
}));

const { ClipMediaTiles, mediaTilesWorker } = await import("./ClipMediaTiles");

const ready: MediaDataState = { status: "ready", peaks: "ready", filmstrip: "ready" };
const base = {
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
  mediaId: "talk",
  mediaData: ready,
  height: 48,
  fps: { num: 30, den: 1 },
  color: "rgb(0, 128, 255)",
};

/** The next draw the worker reports; with `complete`, the next one with every tile loaded. */
const nextDraw = (complete?: boolean) =>
  new Promise<string>((resolve) => {
    const worker = mediaTilesWorker()!;
    const listener = (id: string, done: boolean) => {
      if (complete !== undefined && done !== complete) return;
      worker.drawn.delete(listener);
      resolve(id);
    };
    worker.drawn.add(listener);
  });

const view = (overrides: Partial<ClipView>): ClipView => ({
  source: "s",
  width: 400,
  height: 40,
  pixelRatio: 1,
  firstFrame: 0,
  endFrame: 30 * 40,
  anchorFrame: 0,
  fps: { num: 30, den: 1 },
  color: "rgb(255, 0, 0)",
  ...overrides,
});

describe("media tiles drawing", () => {
  it("draws a flat line where it is silent and a tall waveform where it is loud", () => {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d")!;
    const levels = new Map<number, Float32Array>();
    const missing = drawWaveform(context, view({}), peaksIndex, {
      get: (level, tile) => {
        let bytes = levels.get(level.samplesPerPeak);
        if (bytes === undefined) {
          bytes = levelBytes(level.samplesPerPeak);
          levels.set(level.samplesPerPeak, bytes);
        }
        return bytes.subarray(tile * 4096, tile * 4096 + 4096);
      },
      want: () => {},
    });
    expect(missing).toBe(0);
    expect([canvas.width, canvas.height]).toEqual([400, 40]);
    const column = (x: number) => {
      const pixels = context.getImageData(x, 0, 1, 40).data;
      return Array.from({ length: 40 }, (_, y) => pixels[y * 4 + 3]! > 0).filter(Boolean).length;
    };
    // 40 s across 400 px: 0–12 s loud, 12–20 s quiet.
    expect(column(50)).toBeGreaterThan(20);
    expect(column(160)).toBeLessThanOrEqual(2);
    expect(column(160)).toBeGreaterThan(0);
  });

  it("names the tiles it lacks and leaves their columns empty", () => {
    const canvas = new OffscreenCanvas(1, 1);
    const wanted: number[] = [];
    const missing = drawWaveform(canvas.getContext("2d")!, view({}), peaksIndex, {
      get: () => undefined,
      want: (_level, tile) => wanted.push(tile),
    });
    expect(missing).toBe(wanted.length);
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.length).toBeLessThan(5);
  });

  it("fills filmstrip slots edge to edge with the tile each one names", () => {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d")!;
    const sheet = sheetCanvas();
    // 10 s across 640 px at 72 px high: 128 px slots, 1.9 s apart, so the 1 s level is drawn.
    const missing = drawFilmstrip(
      context,
      view({ width: 640, height: 72, endFrame: 300 }),
      filmstripIndex,
      { get: () => sheet, want: () => {} },
    );
    expect(missing).toBe(0);
    const red = (x: number) => context.getImageData(x, 36, 1, 1).data[0]!;
    // Slot k starts at frame 60k, which is 1 s tile 2k, in sheet column 2k.
    expect(red(60)).toBe(0);
    expect(red(190)).toBe(50);
    expect(red(450)).toBe(150);
  });

  it.each([25, 60])("shows the right tiles for %i fps media in a 30 fps edit", (mediaFps) => {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d")!;
    const sheet = sheetCanvas();
    const second = {
      ...stripLevel(1),
      framesPerTile: mediaFps,
      frames: Array.from({ length: 1800 }, (_, tile) => tile * mediaFps),
    };
    const index = { ...filmstripIndex, rate: { num: mediaFps, den: 1 }, levels: [second] };
    // The view is 10 s in edit frames at 30 fps; slot k is at 2k s, which is 1 s tile 2k.
    drawFilmstrip(context, view({ width: 640, height: 72, endFrame: 300 }), index, {
      get: () => sheet,
      want: () => {},
    });
    const red = (x: number) => context.getImageData(x, 36, 1, 1).data[0]!;
    expect([red(60), red(190), red(450)]).toEqual([0, 50, 150]);
  });
});

describe("ClipMediaTiles", () => {
  it("draws in a worker with OffscreenCanvas, fetching only parts it needs", async () => {
    expect("transferControlToOffscreen" in HTMLCanvasElement.prototype).toBe(true);
    const done = nextDraw(true);
    // StrictMode attaches each canvas twice; a canvas can be transferred only once.
    await using screen = await render(
      <StrictMode>
        <ClipMediaTiles {...base} variant="peaks" width={600} firstFrame={0} endFrame={54_000} />
        <ClipMediaTiles
          {...base}
          variant="filmstrip"
          width={600}
          firstFrame={0}
          endFrame={54_000}
        />
      </StrictMode>,
    );
    await done;
    await expect.poll(() => screen.container.querySelectorAll("canvas").length).toBe(2);
    await expect
      .poll(
        () => new Set(minted.map((resource) => resource._tag === "project-media" && resource.part)),
      )
      .toEqual(new Set(["index", "p16384", "f16s-1", "f16s-2"]));
  });

  it("mints a fresh URL when a signed one stops working", async () => {
    const done = nextDraw(true);
    await using _screen = await render(
      <ClipMediaTiles
        {...base}
        mediaId={STALE_MEDIA}
        variant="peaks"
        width={300}
        firstFrame={0}
        endFrame={900}
      />,
    );
    await done;
    const parts = refreshed.map(
      (resource) => resource._tag === "project-media" && `${resource.mediaId}/${resource.part}`,
    );
    expect(parts).toContain(`${STALE_MEDIA}/index`);
    expect(parts.some((part) => part !== false && /^stale\/p\d+$/u.test(part))).toBe(true);
  });

  it("forgets a clip's URL minter when it unmounts", async () => {
    const source = `${base.environmentId}/${base.projectId}/gone`;
    const screen = await render(
      <ClipMediaTiles
        {...base}
        mediaId="gone"
        variant="peaks"
        width={100}
        firstFrame={0}
        endFrame={30}
      />,
    );
    expect(mediaTilesWorker()!.minters.get(source)?.size).toBe(1);
    await screen.unmount();
    expect(mediaTilesWorker()!.minters.has(source)).toBe(false);
    await screen[Symbol.asyncDispose]();
  });

  it("renders nothing until its part is ready", async () => {
    await using screen = await render(
      <ClipMediaTiles
        {...base}
        mediaData={{ status: "preparing", progress: 0.4, peaks: "ready", filmstrip: "pending" }}
        variant="filmstrip"
        width={600}
        firstFrame={0}
        endFrame={600}
      />,
    );
    expect(screen.container.querySelector("canvas")).toBeNull();
  });

  it("keeps every main-thread task under 50 ms while scrolling and zooming 30 minutes", async () => {
    const long: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) long.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: false });
    const clips = (firstFrame: number, span: number) => (
      <div>
        {[0, 1, 2, 3].map((row) => (
          <div key={row}>
            <ClipMediaTiles
              {...base}
              variant="peaks"
              width={1200}
              firstFrame={firstFrame}
              endFrame={firstFrame + span}
            />
            <ClipMediaTiles
              {...base}
              variant="filmstrip"
              width={1200}
              firstFrame={firstFrame}
              endFrame={firstFrame + span}
              anchorFrame={0}
            />
          </div>
        ))}
      </div>
    );
    await using screen = await render(clips(0, 54_000));
    // Zoom from the whole clip to 13 s, then scroll across 20 minutes.
    // Each step waits for the worker to draw it, so changes arrive at the pace it paints.
    // 54,000 frames down to about 400, each step a new view.
    for (let step = 1; step <= 35; step += 1) {
      const drawn = nextDraw();
      await screen.rerender(clips(0, Math.round(54_000 / 1.15 ** step)));
      await drawn;
    }
    for (let step = 0; step < 60; step += 1) {
      const drawn = nextDraw();
      await screen.rerender(clips(step * 600, 300));
      await drawn;
    }
    await nextDraw(true);
    observer.disconnect();
    expect(long.filter((duration) => duration > 50)).toEqual([]);
  });
});
