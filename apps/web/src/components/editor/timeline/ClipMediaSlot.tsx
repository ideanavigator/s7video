// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A clip's waveform and filmstrip (S7V-035) inside its block (docs/internals/timeline.md). The
 * visible span comes from `TimelineViewContext` outside React, at most once per animation frame,
 * and moves the layer and its canvases directly: a scroll or zoom step re-renders no clip.
 */
import type {
  EditRational,
  EditTrackKind,
  EnvironmentId,
  MediaAsset,
  ProjectId,
} from "@t3tools/contracts";
import { use, useEffect, useRef, useState } from "react";

import { ClipMediaTilesLive, type TilesSpanSource } from "./ClipMediaTiles";
import type { MediaDataVariant } from "./mediaTilesProtocol";
import type { TimelineItem } from "./timelineModel";
import { clipSpanInView, TimelineViewContext, type ClipSpan } from "./timelineView";
import { TIMELINE_TRACK_COLOR } from "./vendor/opencut/theme";

export interface ClipMediaSlotProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: TimelineItem;
  readonly kind: EditTrackKind;
  /** The project media the item shows, from the media library, with its `mediaData`. */
  readonly asset: MediaAsset;
  readonly fps: EditRational;
  readonly heightPx: number;
}

interface Layer {
  readonly variant: MediaDataVariant;
  readonly top: number;
  readonly height: number;
  readonly className: string;
}

/**
 * Video clips show their picture edge to edge with their sound along the bottom; sound clips show
 * only the waveform. Each layer appears once its part is ready.
 */
export function clipMediaLayers(
  kind: EditTrackKind,
  asset: MediaAsset,
  heightPx: number,
): ReadonlyArray<Layer> {
  const data = asset.mediaData;
  const inner = Math.max(0, heightPx - 2);
  const picture = kind === "video" && data?.filmstrip === "ready";
  const sound = (kind === "video" || kind === "sfx" || kind === "music") && data?.peaks === "ready";
  const layers: Layer[] = [];
  if (picture) layers.push({ variant: "filmstrip", top: 0, height: inner, className: "" });
  if (sound) {
    const height = picture ? Math.round(inner * 0.4) : inner;
    layers.push({ variant: "peaks", top: inner - height, height, className: "opacity-70" });
  }
  return layers;
}

export function ClipMediaSlot(props: ClipMediaSlotProps) {
  const layers = clipMediaLayers(props.kind, props.asset, props.heightPx);
  if (layers.length === 0) return null;
  return <ClipMediaLayers {...props} layers={layers} />;
}

/**
 * The clip's visible span from the live view, updated at most once per animation frame. The
 * slot positions its layer and tells its canvases directly, so a zoom step re-renders nothing.
 */
function useLiveSpan(item: TimelineItem, layer: { current: HTMLDivElement | null }) {
  const source = use(TimelineViewContext);
  const [live] = useState(() => {
    const listeners = new Set<() => void>();
    let span: ClipSpan | null = null;
    const tiles: TilesSpanSource = {
      get: () => ({
        width: Math.round(span?.widthPx ?? 0),
        firstFrame: span?.sourceFirstFrame ?? 0,
        endFrame: span?.sourceEndFrame ?? 0,
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const set = (next: ClipSpan, element: HTMLDivElement | null) => {
      if (span !== null && sameSpan(span, next)) return;
      span = next;
      if (element !== null) {
        const visible = next.widthPx >= 1 && next.sourceEndFrame > next.sourceFirstFrame;
        element.style.display = visible ? "" : "none";
        element.style.left = `${next.offsetPx}px`;
        element.dataset.clipMediaSpan = `${next.sourceFirstFrame}-${next.sourceEndFrame}`;
      }
      for (const listener of listeners) listener();
    };
    return { tiles, set };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the timeline's live view, published outside React on every scroll and zoom step.
  useEffect(() => {
    if (source === null) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      live.set(clipSpanInView(item, source.getView()), layer.current);
    };
    update();
    const unsubscribe = source.subscribeView(() => {
      if (frame === null) frame = requestAnimationFrame(update);
    });
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [source, item, live, layer]);
  return live.tiles;
}

const sameSpan = (a: ClipSpan, b: ClipSpan) =>
  a.sourceFirstFrame === b.sourceFirstFrame &&
  a.sourceEndFrame === b.sourceEndFrame &&
  Math.round(a.offsetPx) === Math.round(b.offsetPx) &&
  Math.round(a.widthPx) === Math.round(b.widthPx);

function ClipMediaLayers(props: ClipMediaSlotProps & { readonly layers: ReadonlyArray<Layer> }) {
  const layer = useRef<HTMLDivElement | null>(null);
  const span = useLiveSpan(props.item, layer);
  return (
    // Below the block's label (z-index -1 in the block's own stacking context), above its fill.
    <div
      ref={layer}
      aria-hidden
      className="pointer-events-none absolute top-0 -z-10"
      style={{ color: TIMELINE_TRACK_COLOR[props.kind], display: "none" }}
    >
      {props.layers.map((entry) => (
        <div
          key={entry.variant}
          className={`absolute left-0 ${entry.className}`}
          style={{ top: entry.top }}
        >
          <ClipMediaTilesLive
            environmentId={props.environmentId}
            projectId={props.projectId}
            mediaId={props.asset.id}
            mediaData={props.asset.mediaData}
            variant={entry.variant}
            height={entry.height}
            span={span}
            anchorFrame={props.item.in}
            fps={props.fps}
          />
        </div>
      ))}
    </div>
  );
}
