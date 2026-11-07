// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Where a clip's waveform or filmstrip mounts: the S7V-035 seam (docs/internals/timeline.md). It
 * gets everything `ClipMediaTiles` needs but the pixel span, which it reads outside React from
 * `TimelineViewContext` with `clipSpanInView`. Empty until S7V-035; the block's fill shows meanwhile.
 */
import type {
  EditRational,
  EditTrackKind,
  EnvironmentId,
  MediaAsset,
  ProjectId,
} from "@t3tools/contracts";

import type { TimelineItem } from "./timelineModel";

export interface ClipMediaSlotProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: TimelineItem;
  readonly kind: EditTrackKind;
  /** The project media the item shows, from the media library; its `mediaData` arrives with S7V-035. */
  readonly asset: MediaAsset;
  readonly fps: EditRational;
  readonly heightPx: number;
}

export function ClipMediaSlot(_props: ClipMediaSlotProps) {
  return null;
}
