// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/** Messages between the page and the media-tiles worker (S7V-035). */
import type { EditRational } from "@t3tools/contracts";

export type MediaDataVariant = "peaks" | "filmstrip";

/**
 * What one clip's canvas shows: frames `[firstFrame, endFrame)` across `width`, counted from the
 * media's first frame at `fps`, which may be any rate (the edit's, usually); the worker converts
 * them to each index's own rate.
 */
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
      /** Mint a new URL: the one minted before failed (expired, or the file was made again). */
      readonly refresh: boolean;
    }
  /**
   * The draws of one frame, batched so the page handles one message per frame, not one per clip.
   * `complete`: every tile the view needs was loaded; otherwise more draws follow.
   */
  | {
      readonly type: "drawn";
      readonly draws: ReadonlyArray<{ readonly id: string; readonly complete: boolean }>;
    };
