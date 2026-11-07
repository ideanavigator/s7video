// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Draws clip waveforms and filmstrips into `OffscreenCanvas`es off the main thread (S7V-035).
 * The page only posts views; this worker fetches index files, peak tiles (HTTP ranges) and
 * sheets, caches them, and redraws when they arrive. Signed URLs come from the page on request,
 * since only it can mint them.
 */
import type { MediaFilmstripIndex, MediaPeaksIndex } from "@t3tools/contracts";

import type { ClipView, FromWorker, MediaDataVariant, ToWorker } from "./mediaTilesProtocol";
import { peakTileRange, peaksPart, TileCache } from "./mediaTiles";
import { drawFilmstrip, drawWaveform, type PeakTiles, type Sheets } from "./mediaTilesDraw";

interface Clip {
  readonly canvas: OffscreenCanvas;
  readonly variant: MediaDataVariant;
  view?: ClipView;
  scheduled: boolean;
}

/** The worker scope; the DOM lib types `self` as a window, which also has these. */
const scope = self as unknown as {
  postMessage: (message: FromWorker) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent<ToWorker>) => void) => void;
  requestAnimationFrame?: (callback: () => void) => number;
};
const clips = new Map<string, Clip>();
const indexes = new Map<string, Promise<MediaPeaksIndex | MediaFilmstripIndex | null>>();
const peakTiles = new TileCache<Float32Array>(512);
const sheets = new TileCache<ImageBitmap>(48, (bitmap) => bitmap.close());
const pending = new Set<string>();
const urlRequests = new Map<number, (url: string | null) => void>();
const urls = new Map<string, Promise<string | null>>();
let nextRequest = 0;
const MAX_FETCHES = 6;
let fetching = 0;
const queue: Array<() => Promise<void>> = [];

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posts to its page, with no origin.
const post = (message: FromWorker) => scope.postMessage(message);

const urlFor = (source: string, variant: MediaDataVariant, part: string) => {
  const key = `${source}|${variant}|${part}`;
  let url = urls.get(key);
  if (url === undefined) {
    url = new Promise((resolve) => {
      nextRequest += 1;
      urlRequests.set(nextRequest, resolve);
      post({ type: "need-url", requestId: nextRequest, source, variant, part });
    });
    urls.set(key, url);
    // A failed mint is asked for again next time instead of being remembered.
    void url.then((value) => value === null && urls.delete(key));
  }
  return url;
};

/** Runs `work` when fewer than `MAX_FETCHES` loads are in flight. */
const limited = (work: () => Promise<void>) => {
  queue.push(work);
  const next = () => {
    while (fetching < MAX_FETCHES && queue.length > 0) {
      const job = queue.shift()!;
      fetching += 1;
      void job().finally(() => {
        fetching -= 1;
        next();
      });
    }
  };
  next();
};

const fetchOk = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`media data ${response.status}`);
  return response;
};

const loadIndex = (source: string, variant: MediaDataVariant) => {
  const key = `${source}|${variant}`;
  let index = indexes.get(key);
  if (index === undefined) {
    index = urlFor(source, variant, "index").then(async (url) => {
      if (url === null) return null;
      try {
        return (await (await fetchOk(url)).json()) as MediaPeaksIndex | MediaFilmstripIndex;
      } catch {
        indexes.delete(key);
        urls.delete(`${source}|${variant}|index`);
        return null;
      }
    });
    indexes.set(key, index);
  }
  return index;
};

const redrawAll = (source: string) => {
  for (const [id, clip] of clips) if (clip.view?.source === source) schedule(id, clip);
};

const loadPeakTile = (source: string, level: MediaPeaksIndex["levels"][number], tile: number) => {
  const key = `${source}|${level.samplesPerPeak}|${tile}`;
  if (peakTiles.get(key) !== undefined || pending.has(key)) return;
  pending.add(key);
  limited(async () => {
    try {
      const url = await urlFor(source, "peaks", peaksPart(level));
      if (url === null) return;
      const range = peakTileRange(level, tile);
      const response = await fetchOk(url, { headers: { Range: range.header } });
      const bytes = await response.arrayBuffer();
      // A server that ignores Range sends the whole level: take this tile's slice of it.
      const body = response.status === 206 ? bytes : bytes.slice(range.start);
      peakTiles.set(key, new Float32Array(body, 0, Math.min(range.peaks * 2, body.byteLength / 4)));
      redrawAll(source);
    } catch {
      // Left undrawn; the next view change asks again.
    } finally {
      pending.delete(key);
    }
  });
};

const loadSheet = (source: string, part: string) => {
  const key = `${source}|${part}`;
  if (sheets.get(key) !== undefined || pending.has(key)) return;
  pending.add(key);
  limited(async () => {
    try {
      const url = await urlFor(source, "filmstrip", part);
      if (url === null) return;
      sheets.set(key, await createImageBitmap(await (await fetchOk(url)).blob()));
      redrawAll(source);
    } catch {
      // As above.
    } finally {
      pending.delete(key);
    }
  });
};

const peakTilesOf = (source: string): PeakTiles => ({
  get: (level, tile) => peakTiles.get(`${source}|${level.samplesPerPeak}|${tile}`),
  want: (level, tile) => loadPeakTile(source, level, tile),
});

const sheetsOf = (source: string): Sheets => ({
  get: (part) => sheets.get(`${source}|${part}`),
  want: (part) => loadSheet(source, part),
});

const draw = async (id: string) => {
  const clip = clips.get(id);
  const view = clip?.view;
  if (clip === undefined || view === undefined) return;
  const index = await loadIndex(view.source, clip.variant);
  if (index === null || clips.get(id) !== clip || clip.view !== view) return;
  const context = clip.canvas.getContext("2d");
  if (context === null) return;
  const missing =
    clip.variant === "peaks"
      ? drawWaveform(context, view, index as MediaPeaksIndex, peakTilesOf(view.source))
      : drawFilmstrip(context, view, index as MediaFilmstripIndex, sheetsOf(view.source));
  post({ type: "drawn", id, complete: missing === 0 });
};

const nextFrame: (callback: () => void) => void =
  scope.requestAnimationFrame !== undefined
    ? (callback) => void scope.requestAnimationFrame!(callback)
    : (callback) => setTimeout(callback, 16);

/** One draw per frame per clip, however many views or tiles arrive in between. */
function schedule(id: string, clip: Clip) {
  if (clip.scheduled) return;
  clip.scheduled = true;
  nextFrame(() => {
    clip.scheduled = false;
    void draw(id);
  });
}

scope.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "attach":
      clips.set(message.id, { canvas: message.canvas, variant: message.variant, scheduled: false });
      break;
    case "view": {
      const clip = clips.get(message.id);
      if (clip === undefined) break;
      clip.view = message.view;
      schedule(message.id, clip);
      break;
    }
    case "detach":
      clips.delete(message.id);
      break;
    case "url":
      urlRequests.get(message.requestId)?.(message.url);
      urlRequests.delete(message.requestId);
      break;
  }
});
