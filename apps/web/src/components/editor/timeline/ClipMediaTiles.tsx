// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A clip's waveform or filmstrip (S7V-035), drawn by the shared media-tiles worker into this
 * canvas. Renders nothing until that part of the media's data is ready, so the timeline's own
 * placeholder shows meanwhile. The timeline passes the visible span; nothing here grows with
 * the media's length.
 */
import type { EditRational, EnvironmentId, MediaDataState, ProjectId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { useAssetUrlMinter } from "~/assets/assetUrls";

import type { ClipView, FromWorker, MediaDataVariant, ToWorker } from "./mediaTilesProtocol";

type Minter = (variant: MediaDataVariant, part: string, refresh: boolean) => Promise<string | null>;

interface TilesWorker {
  readonly post: (message: ToWorker, transfer?: Transferable[]) => void;
  /** The page side of each source, per mounted clip, for the worker's URL requests. */
  readonly minters: Map<string, Map<string, Minter>>;
  /** Told after every draw; tests and timing checks wait on it. */
  readonly drawn: Set<(id: string, complete: boolean) => void>;
}

let shared: TilesWorker | null | undefined;

/** One worker for every clip; `null` where canvases cannot be drawn off the main thread. */
export function mediaTilesWorker(): TilesWorker | null {
  if (shared !== undefined) return shared;
  if (
    typeof Worker === "undefined" ||
    typeof HTMLCanvasElement === "undefined" ||
    !("transferControlToOffscreen" in HTMLCanvasElement.prototype)
  ) {
    shared = null;
    return shared;
  }
  const worker = new Worker(new URL("./mediaTiles.worker.ts", import.meta.url), {
    type: "module",
  });
  const minters = new Map<string, Map<string, Minter>>();
  const drawn = new Set<(id: string, complete: boolean) => void>();
  const post = (message: ToWorker, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);
  worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === "drawn") {
      for (const draw of message.draws) {
        for (const listener of drawn) listener(draw.id, draw.complete);
      }
      return;
    }
    const mint = minters.get(message.source)?.values().next().value;
    const answer = (url: string | null) => post({ type: "url", requestId: message.requestId, url });
    if (mint === undefined) answer(null);
    else mint(message.variant, message.part, message.refresh).then(answer, () => answer(null));
  });
  shared = { post, minters, drawn };
  return shared;
}

export interface ClipMediaTilesProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly mediaId: string;
  readonly mediaData: MediaDataState | undefined;
  readonly variant: MediaDataVariant;
  /** The canvas size in CSS pixels: the visible part of the clip. */
  readonly width: number;
  readonly height: number;
  /**
   * Frames `[firstFrame, endFrame)` shown across `width`, counted from the media's first frame
   * (source time, not timeline position) at `fps`. Any rate works: pass the edit's document
   * frames and fps; the worker converts to the waveform's samples and the filmstrip's own rate.
   */
  readonly firstFrame: number;
  readonly endFrame: number;
  /** The frame at the clip's left edge (its trim in point), at `fps`; defaults to `firstFrame`. */
  readonly anchorFrame?: number;
  readonly fps: EditRational;
  /** A CSS colour for the waveform; the worker cannot read theme variables. */
  readonly color?: string;
  readonly className?: string;
}

let nextClip = 0;

/**
 * A canvas can be handed to the worker only once. StrictMode runs the attach effect twice for one
 * canvas, so a detach waits a task and the second attach cancels it.
 */
interface Attached {
  readonly id: string;
  detach?: ReturnType<typeof setTimeout> | undefined;
}

const attached = new WeakMap<HTMLCanvasElement, Attached>();

const attachCanvas = (
  worker: TilesWorker,
  canvas: HTMLCanvasElement,
  variant: MediaDataVariant,
) => {
  const known = attached.get(canvas);
  if (known !== undefined) {
    clearTimeout(known.detach);
    known.detach = undefined;
    return known;
  }
  nextClip += 1;
  const entry: Attached = { id: `clip-${nextClip}` };
  const offscreen = canvas.transferControlToOffscreen();
  worker.post({ type: "attach", id: entry.id, canvas: offscreen, variant }, [offscreen]);
  attached.set(canvas, entry);
  return entry;
};

export function ClipMediaTiles(props: ClipMediaTilesProps) {
  const part = props.variant === "peaks" ? props.mediaData?.peaks : props.mediaData?.filmstrip;
  if (part !== "ready") return null;
  return <ClipMediaCanvas {...props} />;
}

/** What a live canvas shows now; the frames are as in `ClipMediaTilesProps`. */
export interface TilesSpan {
  readonly width: number;
  readonly firstFrame: number;
  readonly endFrame: number;
}

export interface TilesSpanSource {
  readonly get: () => TilesSpan;
  /** Called whenever the span changes; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

export type ClipMediaTilesLiveProps = Omit<
  ClipMediaTilesProps,
  "width" | "firstFrame" | "endFrame"
> & {
  /** Drives the canvas outside React: a scroll or zoom step re-renders nothing. */
  readonly span: TilesSpanSource;
};

/** `ClipMediaTiles` for a span that changes every frame, such as the timeline's live view. */
export function ClipMediaTilesLive(props: ClipMediaTilesLiveProps) {
  const part = props.variant === "peaks" ? props.mediaData?.peaks : props.mediaData?.filmstrip;
  if (part !== "ready") return null;
  return <ClipMediaLiveCanvas {...props} />;
}

type ViewInput = Omit<ClipView, "source" | "pixelRatio" | "color"> & {
  readonly color?: string | undefined;
};

/** Hands a canvas to the worker for one media and variant, and posts views for it. */
function useTilesCanvas(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly mediaId: string;
  readonly variant: MediaDataVariant;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const idRef = useRef<string | null>(null);
  const mint = useAssetUrlMinter(props.environmentId);
  const { environmentId, projectId, mediaId, variant } = props;
  const source = `${environmentId}/${projectId}/${mediaId}`;
  const mintPart = useEffectEvent((partVariant: MediaDataVariant, part: string, refresh: boolean) =>
    mint({ _tag: "project-media", projectId, mediaId, variant: partVariant, part }, { refresh }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the canvas to the worker, which owns it until unmount.
  useEffect(() => {
    const worker = mediaTilesWorker();
    const canvas = canvasRef.current;
    if (worker === null || canvas === null) return;
    const entry = attachCanvas(worker, canvas, variant);
    idRef.current = entry.id;
    const ofSource = worker.minters.get(source) ?? new Map<string, Minter>();
    ofSource.set(entry.id, (partVariant, part, refresh) => mintPart(partVariant, part, refresh));
    worker.minters.set(source, ofSource);
    return () => {
      idRef.current = null;
      ofSource.delete(entry.id);
      if (ofSource.size === 0 && worker.minters.get(source) === ofSource) {
        worker.minters.delete(source);
      }
      entry.detach = setTimeout(() => {
        attached.delete(canvas);
        worker.post({ type: "detach", id: entry.id });
      }, 0);
    };
  }, [source, variant]);

  const inherited = useRef<string | null>(null);
  /**
   * Without a colour, the canvas's inherited text colour is used, since the worker cannot read
   * styles. It is read once per canvas: reading it per view would force a style pass every frame.
   */
  const post = (view: ViewInput) => {
    const worker = mediaTilesWorker();
    const id = idRef.current;
    const canvas = canvasRef.current;
    if (worker === null || id === null || canvas === null) return;
    const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    if (inherited.current === null) inherited.current = getComputedStyle(canvas).color;
    const color = view.color ?? inherited.current;
    worker.post({ type: "view", id, view: { ...view, source, pixelRatio, color } });
  };
  return { canvasRef, key: `${source}/${variant}`, post };
}

function ClipMediaCanvas(props: ClipMediaTilesProps) {
  const { canvasRef, key, post } = useTilesCanvas(props);
  const viewKey = JSON.stringify({
    width: props.width,
    height: props.height,
    firstFrame: props.firstFrame,
    endFrame: props.endFrame,
    anchorFrame: props.anchorFrame ?? props.firstFrame,
    fps: props.fps,
    color: props.color,
  } satisfies ViewInput);
  const postView = useEffectEvent((view: ViewInput) => post(view));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the worker's view of this clip in step with its props.
  useEffect(() => {
    postView(JSON.parse(viewKey) as ViewInput);
  }, [viewKey]);

  return (
    <canvas
      key={key}
      ref={canvasRef}
      className={props.className}
      style={{ width: props.width, height: props.height, display: "block" }}
      data-media-tiles={props.variant}
      aria-hidden
    />
  );
}

function ClipMediaLiveCanvas(props: ClipMediaTilesLiveProps) {
  const { canvasRef, key, post } = useTilesCanvas(props);
  const { span, height, fps, color } = props;
  const anchor = props.anchorFrame;
  const postView = useEffectEvent((view: ViewInput) => post(view));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the live span outside React: sizes the canvas and posts each view to the worker.
  useEffect(() => {
    const update = () => {
      const now = span.get();
      const canvas = canvasRef.current;
      if (canvas !== null) canvas.style.width = `${now.width}px`;
      if (now.width <= 0 || now.endFrame <= now.firstFrame) return;
      postView({
        width: now.width,
        height,
        firstFrame: now.firstFrame,
        endFrame: now.endFrame,
        anchorFrame: anchor ?? now.firstFrame,
        fps,
        color,
      });
    };
    update();
    return span.subscribe(update);
  }, [span, height, fps, anchor, color, canvasRef]);

  return (
    <canvas
      key={key}
      ref={canvasRef}
      className={props.className}
      style={{ height, display: "block" }}
      data-media-tiles={props.variant}
      aria-hidden
    />
  );
}
