// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The drag preview (S7V-034), written by ref outside React: a ghost block per moving item in a
 * layer over the lanes, the snap line, and a dimmed original. Nothing is written to the edit
 * until the gesture ends, and React renders nothing while the pointer moves.
 */
import type { EditTrackKind } from "@t3tools/contracts";

import { TIMELINE_TRACK_COLOR } from "./vendor/opencut/theme";

export interface PreviewBlock {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly start: number;
  readonly duration: number;
}

export interface RowGeometry {
  readonly top: number;
  readonly height: number;
  readonly kind: EditTrackKind;
}

export interface DragPreview {
  readonly attach: (layer: HTMLDivElement | null) => void;
  /** Shows the blocks at `pxPerFrame`; `blocked` draws them refused. */
  readonly show: (
    blocks: ReadonlyArray<PreviewBlock>,
    blocked: boolean,
    pxPerFrame: number,
    rows: ReadonlyArray<RowGeometry>,
  ) => void;
  readonly showSnap: (frame: number | null, pxPerFrame: number) => void;
  readonly clear: () => void;
  /** Outlines the items' own blocks as refused for a moment, after a refused gesture. */
  readonly flashBlocked: (itemIds: Iterable<string>) => void;
  readonly active: () => boolean;
}

const BLOCKED_FLASH_MS = 900;

export function createDragPreview(): DragPreview {
  let layer: HTMLDivElement | null = null;
  let snapLine: HTMLDivElement | null = null;
  const ghosts = new Map<string, HTMLDivElement>();
  const dimmed = new Set<string>();
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let flashed: HTMLElement[] = [];

  const blockOf = (itemId: string) =>
    layer?.parentElement?.querySelector<HTMLElement>(
      `[data-timeline-item="${CSS.escape(itemId)}"]`,
    ) ?? null;

  const setDimmed = (ids: ReadonlySet<string>) => {
    for (const id of dimmed) {
      if (ids.has(id)) continue;
      blockOf(id)?.removeAttribute("data-editing");
      dimmed.delete(id);
    }
    for (const id of ids) {
      if (dimmed.has(id)) continue;
      blockOf(id)?.setAttribute("data-editing", "true");
      dimmed.add(id);
    }
  };

  const ghostFor = (itemId: string) => {
    let ghost = ghosts.get(itemId);
    if (ghost === undefined && layer !== null) {
      ghost = document.createElement("div");
      ghost.dataset.timelineGhost = itemId;
      ghost.className = "absolute rounded-sm border-2 data-[blocked=true]:border-destructive";
      layer.append(ghost);
      ghosts.set(itemId, ghost);
    }
    return ghost;
  };

  const clearGhosts = () => {
    for (const ghost of ghosts.values()) ghost.remove();
    ghosts.clear();
    setDimmed(new Set());
  };

  return {
    attach: (element) => {
      if (element === null) {
        clearGhosts();
        snapLine?.remove();
        snapLine = null;
      }
      layer = element;
    },
    show: (blocks, blocked, pxPerFrame, rows) => {
      if (layer === null) return;
      const ids = new Set(blocks.map((block) => block.itemId));
      for (const [id, ghost] of ghosts) {
        if (ids.has(id)) continue;
        ghost.remove();
        ghosts.delete(id);
      }
      for (const block of blocks) {
        const row = rows[block.rowIndex];
        const ghost = ghostFor(block.itemId);
        if (row === undefined || ghost === undefined) continue;
        const color = TIMELINE_TRACK_COLOR[row.kind];
        ghost.style.cssText = `left:${block.start * pxPerFrame}px;top:${row.top}px;width:${Math.max(1, block.duration * pxPerFrame - 1)}px;height:${row.height}px;background:color-mix(in srgb, ${color} 55%, var(--card));`;
        if (!blocked) ghost.style.borderColor = color;
        ghost.dataset.blocked = String(blocked);
      }
      layer.dataset.blocked = String(blocked);
      setDimmed(ids);
    },
    showSnap: (frame, pxPerFrame) => {
      if (layer === null) return;
      if (frame === null) {
        snapLine?.remove();
        snapLine = null;
        return;
      }
      if (snapLine === null) {
        snapLine = document.createElement("div");
        snapLine.dataset.testid = "timeline-snap-line";
        snapLine.dataset.timelineSnap = "";
        snapLine.className = "absolute inset-y-0 w-px bg-primary";
        layer.append(snapLine);
      }
      snapLine.dataset.frame = String(frame);
      snapLine.style.left = `${frame * pxPerFrame}px`;
    },
    clear: () => {
      clearGhosts();
      snapLine?.remove();
      snapLine = null;
      if (layer !== null) delete layer.dataset.blocked;
    },
    flashBlocked: (itemIds) => {
      if (flashTimer !== null) clearTimeout(flashTimer);
      for (const element of flashed) element.removeAttribute("data-blocked");
      flashed = [];
      for (const id of itemIds) {
        const block = blockOf(id);
        if (block === null) continue;
        block.dataset.blocked = "true";
        flashed.push(block);
      }
      flashTimer = setTimeout(() => {
        flashTimer = null;
        for (const element of flashed) element.removeAttribute("data-blocked");
        flashed = [];
      }, BLOCKED_FLASH_MS);
    },
    active: () => ghosts.size > 0,
  };
}
