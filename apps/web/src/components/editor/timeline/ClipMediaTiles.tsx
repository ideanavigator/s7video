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

type Minter = (variant: MediaDataVariant, part: string) => Promise<string | null>;

interface TilesWorker {
  readonly post: (message: ToWorker, transfer?: Transferable[]) => void;
  /** The page side of each source, for the worker's URL requests. */
  readonly minters: Map<string, Minter>;
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
  const minters = new Map<string, Minter>();
  const drawn = new Set<(id: string, complete: boolean) => void>();
  const post = (message: ToWorker, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);
  worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === "drawn") {
      for (const listener of drawn) listener(message.id, message.complete);
      return;
    }
    const mint = minters.get(message.source);
    const answer = (url: string | null) => post({ type: "url", requestId: message.requestId, url });
    if (mint === undefined) answer(null);
    else mint(message.variant, message.part).then(answer, () => answer(null));
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
  /** Media frames `[firstFrame, endFrame)` at `fps` shown across `width`. */
  readonly firstFrame: number;
  readonly endFrame: number;
  /** The frame at the clip's left edge (its trim in point); defaults to `firstFrame`. */
  readonly anchorFrame?: number;
  readonly fps: EditRational;
  /** A CSS colour for the waveform; the worker cannot read theme variables. */
  readonly color?: string;
  readonly className?: string;
}

let nextClip = 0;

export function ClipMediaTiles(props: ClipMediaTilesProps) {
  const part = props.variant === "peaks" ? props.mediaData?.peaks : props.mediaData?.filmstrip;
  if (part !== "ready") return null;
  return <ClipMediaCanvas {...props} />;
}

function ClipMediaCanvas(props: ClipMediaTilesProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const idRef = useRef<string | null>(null);
  const mint = useAssetUrlMinter(props.environmentId);
  const { environmentId, projectId, mediaId, variant } = props;
  const source = `${environmentId}/${projectId}/${mediaId}`;
  const mintPart = useEffectEvent((partVariant: MediaDataVariant, part: string) =>
    mint({ _tag: "project-media", projectId, mediaId, variant: partVariant, part }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the canvas to the worker, which owns it until unmount.
  useEffect(() => {
    const worker = mediaTilesWorker();
    const canvas = canvasRef.current;
    if (worker === null || canvas === null) return;
    nextClip += 1;
    const id = `clip-${nextClip}`;
    idRef.current = id;
    worker.minters.set(source, (partVariant, part) => mintPart(partVariant, part));
    const offscreen = canvas.transferControlToOffscreen();
    worker.post({ type: "attach", id, canvas: offscreen, variant }, [offscreen]);
    return () => {
      worker.post({ type: "detach", id });
      idRef.current = null;
    };
  }, [source, variant]);

  const view: Omit<ClipView, "color"> & { readonly color: string | null } = {
    source,
    width: props.width,
    height: props.height,
    pixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    firstFrame: props.firstFrame,
    endFrame: props.endFrame,
    anchorFrame: props.anchorFrame ?? props.firstFrame,
    fps: props.fps,
    color: props.color ?? null,
  };
  const viewKey = JSON.stringify(view);

  // Without a colour, the canvas's inherited text colour is used; the worker cannot read styles.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the worker's view of this clip in step with its props.
  useEffect(() => {
    const worker = mediaTilesWorker();
    const id = idRef.current;
    const canvas = canvasRef.current;
    if (worker === null || id === null || canvas === null) return;
    const next = JSON.parse(viewKey) as typeof view;
    const color = next.color ?? getComputedStyle(canvas).color;
    worker.post({ type: "view", id, view: { ...next, color } });
  }, [viewKey]);

  return (
    <canvas
      key={`${source}/${variant}`}
      ref={canvasRef}
      className={props.className}
      style={{ width: props.width, height: props.height, display: "block" }}
      data-media-tiles={variant}
      aria-hidden
    />
  );
}
