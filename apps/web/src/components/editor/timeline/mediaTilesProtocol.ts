// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** Messages between the page and the media-tiles worker (S7V-035). */
import type { EditRational } from "@t3tools/contracts";

export type MediaDataVariant = "peaks" | "filmstrip";

/** What one clip's canvas shows: media frames `[firstFrame, endFrame)` at `fps` across `width`. */
export interface ClipView {
  /** Names the media: tiles are cached per source and shared by clips of the same media. */
  readonly source: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly firstFrame: number;
  readonly endFrame: number;
  /** The frame at the clip's left edge, where filmstrip slots start. */
  readonly anchorFrame: number;
  readonly fps: EditRational;
  readonly color: string;
}

export type ToWorker =
  | {
      readonly type: "attach";
      readonly id: string;
      readonly canvas: OffscreenCanvas;
      readonly variant: MediaDataVariant;
    }
  | { readonly type: "view"; readonly id: string; readonly view: ClipView }
  | { readonly type: "detach"; readonly id: string }
  | { readonly type: "url"; readonly requestId: number; readonly url: string | null };

export type FromWorker =
  | {
      readonly type: "need-url";
      readonly requestId: number;
      readonly source: string;
      readonly variant: MediaDataVariant;
      readonly part: string;
    }
  /** `complete`: every tile the view needs was loaded; otherwise more draws follow. */
  | { readonly type: "drawn"; readonly id: string; readonly complete: boolean };
