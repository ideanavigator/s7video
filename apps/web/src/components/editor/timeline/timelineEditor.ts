// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Timeline editing (S7V-034), outside React like `timelineController.ts`: selection, the ported
 * resize and element-interaction controllers, split, delete, nudges, undo and redo. Every
 * finished gesture is one `edit.apply` batch (one history step), sent with the revision the
 * timeline shows. An edit from elsewhere (the assistant) that lands mid-gesture cancels it.
 */
import type { EditOp, EditRational } from "@t3tools/contracts";

import { formatPlaybackClock } from "../../../editor/editPlayback";
import { createDragPreview, type PreviewBlock, type RowGeometry } from "./dragPreview";
import {
  ElementInteractionController,
  type MoveGesture,
} from "./controllers/elementInteractionController";
import { withLinkedItems } from "./controllers/groupMove";
import type { ResizeSide } from "./controllers/groupResize";
import { ResizeController } from "./controllers/resizeController";
import type { TimelineRow } from "./timelineModel";
import { deleteOps, planGesture, splitOps, type TimelineGesture } from "./timelineEdits";
import { TIMELINE_TRACK_GAP_PX, TIMELINE_TRACK_HEIGHTS_PX } from "./vendor/opencut/theme";

export type EditApplyOutcome =
  | { readonly _tag: "applied"; readonly revision: number }
  /** The edit changed since `baseRevision` (EditConflict). */
  | { readonly _tag: "conflict" }
  /** The ops would make an invalid edit, such as an overlap (EditValidationError, EditOpError). */
  | { readonly _tag: "refused"; readonly message: string }
  | { readonly _tag: "failed"; readonly message: string };

export type EditStepOutcome =
  | { readonly _tag: "applied"; readonly revision: number }
  | { readonly _tag: "nothing" }
  | { readonly _tag: "failed"; readonly message: string };

export type TimelineNotice =
  | { readonly kind: "changed-elsewhere" }
  | { readonly kind: "failed"; readonly title: string; readonly message: string };

export interface TimelineEditActions {
  readonly apply: (ops: ReadonlyArray<EditOp>, baseRevision: number) => Promise<EditApplyOutcome>;
  readonly undo: () => Promise<EditStepOutcome>;
  readonly redo: () => Promise<EditStepOutcome>;
  readonly notify: (notice: TimelineNotice) => void;
}

export interface TimelineEditorState {
  /** What the user picked. */
  readonly selected: ReadonlySet<string>;
  /** The selection with its linked items: what an edit changes, and what is highlighted. */
  readonly highlighted: ReadonlySet<string>;
}

export interface TimelineEditorHost {
  readonly pxPerFrame: () => number;
  readonly playheadFrame: () => number;
  /** Focuses the timeline, so its keys work after a clip is pressed. */
  readonly focus: () => void;
}

export interface TimelineEditor {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => TimelineEditorState;
  readonly setModel: (
    rows: ReadonlyArray<TimelineRow>,
    revision: number,
    fps: EditRational,
  ) => void;
  readonly setActions: (actions: TimelineEditActions | null) => void;
  /** The lanes column: pointer presses on clips and trim handles start gestures here. */
  readonly attachLanes: (element: HTMLDivElement | null) => (() => void) | undefined;
  readonly attachPreview: (element: HTMLDivElement | null) => void;
  readonly attachAnnouncer: (element: HTMLElement | null) => void;
  /** Handles a key on the timeline; true when it was an edit key. */
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
  readonly split: () => void;
  readonly deleteSelection: (ripple: boolean) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly destroy: () => void;
}

/** Arrow nudges on the same selection within this long make one move, so one undo step. */
export const NUDGE_SETTLE_MS = 800;

const EMPTY: ReadonlySet<string> = new Set();

const MOVE_REFUSED: Record<string, string> = {
  overlap: "That spot overlaps another clip, so the clip went back.",
  "other-kind": "Clips can only move to a track of the same kind.",
  locked: "That track is locked.",
  missing: "That clip is no longer in the edit.",
};

/** A press this close to a clip's edge trims it, handle or not. */
const EDGE_GRAB_PX = 6;

function edgeUnder(block: HTMLElement, clientX: number): "start" | "end" | undefined {
  const rect = block.getBoundingClientRect();
  // A clip too narrow for both edge zones and a middle is moved, not trimmed.
  if (rect.width < EDGE_GRAB_PX * 3) return undefined;
  if (clientX - rect.left <= EDGE_GRAB_PX) return "start";
  if (rect.right - clientX <= EDGE_GRAB_PX) return "end";
  return undefined;
}

function rowGeometryOf(rows: ReadonlyArray<TimelineRow>): RowGeometry[] {
  let top = TIMELINE_TRACK_GAP_PX;
  return rows.map((row) => {
    const height = TIMELINE_TRACK_HEIGHTS_PX[row.kind];
    const geometry = { top, height, kind: row.kind };
    top += height + TIMELINE_TRACK_GAP_PX;
    return geometry;
  });
}

export function createTimelineEditor(host: TimelineEditorHost): TimelineEditor {
  const listeners = new Set<() => void>();
  let rows: ReadonlyArray<TimelineRow> = [];
  let geometry: RowGeometry[] = [];
  let fps: EditRational = { num: 30, den: 1 };
  let revision = -1;
  /** The newest revision explained by this timeline's own requests (or seen while idle). */
  let knownRevision: number | null = null;
  let inFlight = 0;
  /** A preview stays up until the edit it was sent for arrives, so the clip never jumps back. */
  let clearAtRevision: number | null = null;
  let actions: TimelineEditActions | null = null;
  let state: TimelineEditorState = { selected: EMPTY, highlighted: EMPTY };
  let lanes: HTMLDivElement | null = null;
  let lanesTop = 0;
  let announcer: HTMLElement | null = null;
  const preview = createDragPreview();
  /** Gestures waiting for this timeline's previous request and its revision to land. */
  let queued: Array<() => void> = [];
  let nudge: {
    readonly itemIds: ReadonlyArray<string>;
    delta: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setSelection = (selected: ReadonlySet<string>) => {
    if (selected === state.selected) return;
    state = { selected, highlighted: withLinkedItems(rows, selected) };
    emit();
  };

  const announce = (message: string) => {
    if (announcer !== null) announcer.textContent = message;
  };

  const settled = () => inFlight === 0 && knownRevision !== null && revision >= knownRevision;
  const runQueued = () => {
    while (queued.length > 0 && settled()) queued.shift()!();
  };
  const whenSettled = (run: () => void) => {
    if (settled() && queued.length === 0) run();
    else queued.push(run);
  };

  const showBlocks = (blocks: ReadonlyArray<PreviewBlock>, blocked: boolean) =>
    preview.show(blocks, blocked, host.pxPerFrame(), geometry);

  const element: ElementInteractionController = new ElementInteractionController({
    getRows: () => rows,
    getSelected: () => state.selected,
    select: (itemId, mode) => {
      if (mode === "only") setSelection(new Set([itemId]));
      else {
        const next = new Set(state.selected);
        if (next.has(itemId)) next.delete(itemId);
        else next.add(itemId);
        setSelection(next);
      }
    },
    pxPerFrame: host.pxPerFrame,
    playheadFrame: host.playheadFrame,
    rowIndexAtClientY: (clientY) => {
      const y = clientY - lanesTop;
      return geometry.findIndex(
        (row) => y >= row.top && y < row.top + row.height + TIMELINE_TRACK_GAP_PX,
      );
    },
    previewMove: (result, snapFrame) => {
      showBlocks(
        result.moves.map((move) => ({
          itemId: move.itemId,
          rowIndex: move.toRowIndex,
          start: move.start,
          duration: move.duration,
        })),
        result.refused !== null,
      );
      preview.showSnap(snapFrame, host.pxPerFrame());
    },
    discardPreview: () => preview.clear(),
    commitMove: (gesture) => commit(gesture),
    refuseMove: (itemIds, result) => {
      preview.flashBlocked(itemIds);
      announce(MOVE_REFUSED[result.refused ?? "overlap"]!);
    },
  });

  const resize: ResizeController = new ResizeController({
    getRows: () => rows,
    getSelected: () => state.selected,
    pxPerFrame: host.pxPerFrame,
    playheadFrame: host.playheadFrame,
    previewResize: (result, snapFrame) => {
      showBlocks(result.updates, false);
      preview.showSnap(snapFrame, host.pxPerFrame());
    },
    discardPreview: () => preview.clear(),
    commitTrim: (gesture) => commit(gesture),
  });

  const describe = (gesture: TimelineGesture): string => {
    const first = rows.flatMap((row) => row.items).find((item) => item.id === gesture.itemIds[0]);
    const clips = gesture.itemIds.length === 1 ? "clip" : "clips";
    if (first === undefined) return "";
    if (gesture.kind === "move") {
      return `Moved ${clips} to ${formatPlaybackClock(Math.max(0, first.start + gesture.delta), fps)}`;
    }
    return `Trimmed ${clips}`;
  };

  const send = async (ops: ReadonlyArray<EditOp>, itemIds: ReadonlyArray<string>, done: string) => {
    if (actions === null) {
      preview.clear();
      return;
    }
    inFlight += 1;
    const base = revision;
    const outcome = await actions.apply(ops, base);
    inFlight -= 1;
    switch (outcome._tag) {
      case "applied":
        knownRevision = Math.max(knownRevision ?? outcome.revision, outcome.revision);
        if (revision >= outcome.revision) preview.clear();
        else clearAtRevision = outcome.revision;
        announce(done);
        break;
      case "conflict":
        preview.clear();
        actions.notify({ kind: "changed-elsewhere" });
        break;
      case "refused":
        preview.clear();
        preview.flashBlocked(itemIds);
        announce(outcome.message);
        break;
      case "failed":
        preview.clear();
        actions.notify({
          kind: "failed",
          title: "Couldn't change the edit",
          message: outcome.message,
        });
        break;
    }
    afterRequest();
  };

  /** Plans a finished gesture against the rows at send time, then sends it as one batch. */
  const commit = (gesture: TimelineGesture) => {
    whenSettled(() => {
      const planned = planGesture(rows, gesture);
      if (planned.refused !== null) {
        preview.clear();
        preview.flashBlocked(gesture.itemIds);
        announce(MOVE_REFUSED[planned.refused]!);
        return;
      }
      if (planned.ops.length === 0) {
        preview.clear();
        return;
      }
      showBlocks(planned.blocks, false);
      preview.showSnap(null, host.pxPerFrame());
      void send(planned.ops, gesture.itemIds, describe(gesture));
    });
  };

  const discardNudge = () => {
    if (nudge === null) return;
    if (nudge.timer !== null) clearTimeout(nudge.timer);
    nudge = null;
    preview.clear();
  };

  const flushNudge = () => {
    if (nudge === null) return;
    const { itemIds, delta, timer } = nudge;
    if (timer !== null) clearTimeout(timer);
    nudge = null;
    if (delta === 0) {
      preview.clear();
      return;
    }
    commit({ kind: "move", delta, itemIds, toRowId: null } satisfies MoveGesture);
  };

  const nudgeBy = (frames: number) => {
    const itemIds = [...state.highlighted];
    const same =
      nudge !== null &&
      nudge.itemIds.length === itemIds.length &&
      nudge.itemIds.every((id) => state.highlighted.has(id));
    if (!same) flushNudge();
    if (nudge === null) nudge = { itemIds, delta: 0, timer: null };
    const current = nudge;
    current.delta += frames;
    const planned = planGesture(rows, {
      kind: "move",
      delta: current.delta,
      itemIds,
      toRowId: null,
    });
    // A nudge cannot go before frame 0: keep the delta where the clamp put it.
    const anchor = rows.flatMap((row) => row.items).find((item) => item.id === itemIds[0]);
    const landed = planned.blocks.find((block) => block.itemId === itemIds[0]);
    if (anchor !== undefined && landed !== undefined) current.delta = landed.start - anchor.start;
    showBlocks(planned.blocks, planned.refused !== null);
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = setTimeout(flushNudge, NUDGE_SETTLE_MS);
  };

  /** Cancels whatever gesture is open because the edit changed under it. */
  const changedElsewhere = () => {
    const open = element.isDragging || resize.isResizing || nudge !== null || queued.length > 0;
    element.cancel();
    resize.cancel();
    discardNudge();
    queued = [];
    preview.clear();
    clearAtRevision = null;
    if (open) actions?.notify({ kind: "changed-elsewhere" });
  };

  const afterRequest = () => {
    if (inFlight === 0 && knownRevision !== null && revision > knownRevision) {
      knownRevision = revision;
      changedElsewhere();
    }
    runQueued();
  };

  const step = async (direction: "undo" | "redo") => {
    discardNudge();
    element.cancel();
    resize.cancel();
    if (actions === null) return;
    inFlight += 1;
    const outcome = await (direction === "undo" ? actions.undo() : actions.redo());
    inFlight -= 1;
    if (outcome._tag === "applied") {
      knownRevision = Math.max(knownRevision ?? outcome.revision, outcome.revision);
      announce(direction === "undo" ? "Undone" : "Redone");
    } else if (outcome._tag === "failed") {
      actions.notify({
        kind: "failed",
        title: direction === "undo" ? "Couldn't undo" : "Couldn't redo",
        message: outcome.message,
      });
    }
    afterRequest();
  };

  const sendNow = (ops: ReadonlyArray<EditOp>, itemIds: ReadonlyArray<string>, done: string) => {
    flushNudge();
    whenSettled(() => {
      if (ops.length > 0) void send(ops, itemIds, done);
    });
  };

  const split = () => {
    const ops = splitOps(rows, state.selected, host.playheadFrame());
    if (ops.length === 0) {
      announce("No clip to split at the playhead.");
      return;
    }
    sendNow(ops, [], ops.length === 1 ? "Split the clip" : "Split the clips");
  };

  const deleteSelection = (ripple: boolean) => {
    const ops = deleteOps(rows, state.selected, ripple);
    if (ops.length === 0) return;
    setSelection(EMPTY);
    sendNow(ops, [], ripple ? "Deleted and closed the gap" : "Deleted");
  };

  const onPointerDown = (event: PointerEvent) => {
    // A read-only timeline (no edit RPCs) seeks on every press, as before S7V-034.
    if (actions === null || event.button !== 0 || !(event.target instanceof Element)) return;
    const block = event.target.closest<HTMLElement>("[data-timeline-item]");
    if (block === null || lanes === null) {
      if (!event.shiftKey) setSelection(EMPTY);
      return;
    }
    // A press on a clip edits; it does not seek (the scroller's listener would).
    event.stopPropagation();
    event.preventDefault();
    host.focus();
    flushNudge();
    lanesTop = lanes.getBoundingClientRect().top;
    const itemId = block.dataset.timelineItem!;
    const side =
      event.target.closest<HTMLElement>("[data-trim-handle]")?.dataset.trimHandle ??
      edgeUnder(block, event.clientX);
    if (side === "start" || side === "end") {
      if (!state.selected.has(itemId)) setSelection(new Set([itemId]));
      resize.onResizeStart({
        pointerId: event.pointerId,
        clientX: event.clientX,
        itemId,
        side: side satisfies ResizeSide,
      });
      return;
    }
    element.onPointerDown({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      itemId,
      shift: event.shiftKey,
    });
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    setModel: (nextRows, nextRevision, nextFps) => {
      rows = nextRows;
      geometry = rowGeometryOf(nextRows);
      fps = nextFps;
      revision = nextRevision;
      if (clearAtRevision !== null && nextRevision >= clearAtRevision) {
        clearAtRevision = null;
        preview.clear();
      }
      if (knownRevision === null) knownRevision = nextRevision;
      else if (inFlight === 0 && nextRevision !== knownRevision) {
        knownRevision = nextRevision;
        changedElsewhere();
      }
      // Clips the new edit no longer has drop out of the selection.
      const present = new Set(nextRows.flatMap((row) => row.items.map((item) => item.id)));
      const kept = [...state.selected].filter((id) => present.has(id));
      if (kept.length !== state.selected.size)
        setSelection(kept.length === 0 ? EMPTY : new Set(kept));
      else if (state.selected.size > 0) {
        const highlighted = withLinkedItems(rows, state.selected);
        const same =
          highlighted.size === state.highlighted.size &&
          [...highlighted].every((id) => state.highlighted.has(id));
        if (!same) {
          state = { selected: state.selected, highlighted };
          emit();
        }
      }
      runQueued();
    },
    setActions: (next) => {
      actions = next;
    },
    attachLanes: (next) => {
      lanes = next;
      if (next === null) return undefined;
      next.addEventListener("pointerdown", onPointerDown);
      return () => {
        next.removeEventListener("pointerdown", onPointerDown);
        if (lanes === next) lanes = null;
      };
    },
    attachPreview: (next) => preview.attach(next),
    attachAnnouncer: (next) => {
      announcer = next;
    },
    onKeyDown: (event) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void step(event.shiftKey ? "redo" : "undo");
        return true;
      }
      if (command || event.altKey) return false;
      if (event.key === "Escape") {
        if (element.isDragging || resize.isResizing || nudge !== null) {
          element.cancel();
          resize.cancel();
          discardNudge();
        } else setSelection(EMPTY);
        return true;
      }
      if (event.key === "s" || event.key === "S") {
        if (event.shiftKey) return false;
        event.preventDefault();
        split();
        return true;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (state.selected.size === 0) return false;
        event.preventDefault();
        deleteSelection(event.shiftKey);
        return true;
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && state.selected.size > 0) {
        event.preventDefault();
        const frames = event.shiftKey ? Math.round(fps.num / fps.den) : 1;
        nudgeBy(event.key === "ArrowLeft" ? -frames : frames);
        return true;
      }
      return false;
    },
    split,
    deleteSelection,
    undo: () => void step("undo"),
    redo: () => void step("redo"),
    destroy: () => {
      discardNudge();
      element.destroy();
      resize.destroy();
      preview.clear();
      listeners.clear();
    },
  };
}
