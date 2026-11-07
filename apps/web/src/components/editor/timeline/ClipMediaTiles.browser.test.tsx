// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EnvironmentId,
  type AssetResource,
  type MediaDataState,
  type MediaFilmstripIndex,
  type MediaPeaksIndex,
  ProjectId,
} from "@t3tools/contracts";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { drawFilmstrip, drawWaveform } from "./mediaTilesDraw";
import type { ClipView } from "./mediaTilesProtocol";

// 30 minutes at 48 kHz: a tone for 12 s of every 20, silence in between.
const SAMPLES = 30 * 60 * 48_000;
const LEVELS = [256, 1024, 4096, 16_384];
const peaksIndex: MediaPeaksIndex = {
  version: 1,
  audio: true,
  sampleRate: 48_000,
  channels: 1,
  durationSamples: SAMPLES,
  offsetSamples: 0,
  levels: LEVELS.map((samplesPerPeak) => ({
    samplesPerPeak,
    count: Math.ceil(SAMPLES / samplesPerPeak),
    file: `${samplesPerPeak}.f32`,
  })),
};
const loud = (sample: number) => sample % (20 * 48_000) < 12 * 48_000;
const levelBytes = (samplesPerPeak: number) => {
  const count = Math.ceil(SAMPLES / samplesPerPeak);
  const pairs = new Float32Array(count * 2);
  for (let peak = 0; peak < count; peak += 1) {
    const level = loud(peak * samplesPerPeak) ? 0.6 : 0;
    pairs[peak * 2] = -level;
    pairs[peak * 2 + 1] = level;
  }
  return pairs;
};

const stripLevel = (seconds: number) => {
  const tiles = Math.ceil(1800 / seconds);
  return {
    level: `${seconds}s`,
    secondsPerTile: seconds,
    framesPerTile: seconds * 30,
    sheets: Array.from({ length: Math.ceil(tiles / 100) }, (_, n) => `${seconds}s-${n + 1}.jpg`),
    frames: Array.from({ length: tiles }, (_, tile) => tile * seconds * 30),
  };
};
const filmstripIndex: MediaFilmstripIndex = {
  version: 1,
  video: true,
  rate: { num: 30, den: 1 },
  tileWidth: 160,
  tileHeight: 90,
  columns: 10,
  rows: 10,
  levels: [stripLevel(16), stripLevel(4), stripLevel(1)],
};

/** A sheet whose tile in column `c` is a flat colour, so a drawn slot shows which tile it is. */
const sheetCanvas = () => {
  const canvas = new OffscreenCanvas(1600, 900);
  const context = canvas.getContext("2d")!;
  for (let column = 0; column < 10; column += 1) {
    context.fillStyle = `rgb(${column * 25}, 0, ${255 - column * 25})`;
    context.fillRect(column * 160, 0, 160, 900);
  }
  return canvas;
};

// Served once per part for the whole file; the page that holds them goes with the test run.
const blobUrl = (blob: Blob) => URL.createObjectURL(blob);

const served = new Map<string, Promise<string>>();
const minted: AssetResource[] = [];
const serve = (resource: AssetResource) => {
  if (resource._tag !== "project-media" || resource.part === undefined) return null;
  const key = `${resource.variant}/${resource.part}`;
  let url = served.get(key);
  if (url === undefined) {
    url = (async () => {
      if (resource.part === "index") {
        const index = resource.variant === "peaks" ? peaksIndex : filmstripIndex;
        return blobUrl(new Blob([JSON.stringify(index)], { type: "application/json" }));
      }
      if (resource.variant === "peaks") {
        return blobUrl(new Blob([levelBytes(Number(resource.part!.slice(1)))]));
      }
      return blobUrl(await sheetCanvas().convertToBlob({ type: "image/jpeg", quality: 0.9 }));
    })();
    served.set(key, url);
  }
  return url;
};

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlMinter: () => async (resource: AssetResource) => {
    minted.push(resource);
    return (await serve(resource)) ?? null;
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
