// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The timeline's edit buttons (S7V-034): split at the playhead, delete (leaves a gap), ripple
 * delete (closes it), undo and redo. Each matches a key on the timeline; titles name the key.
 */
import { Redo2Icon, ScissorsIcon, Trash2Icon, Undo2Icon } from "lucide-react";

import { Button } from "../../ui/button";

export function TimelineToolbar(props: {
  readonly hasSelection: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onSplit: () => void;
  readonly onDelete: (ripple: boolean) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Timeline editing"
      className="flex h-8 shrink-0 items-center gap-1 border-b px-1"
    >
      <Button
        size="compact"
        variant="ghost"
        title="Split at the playhead (S)"
        onClick={props.onSplit}
      >
        <ScissorsIcon aria-hidden />
        Split
      </Button>
      <Button
        size="compact"
        variant="ghost"
        title="Delete, leaving a gap (Delete)"
        disabled={!props.hasSelection}
        onClick={() => props.onDelete(false)}
      >
        <Trash2Icon aria-hidden />
        Delete
      </Button>
      <Button
        size="compact"
        variant="ghost"
        title="Delete and close the gap (Shift+Delete)"
        disabled={!props.hasSelection}
        onClick={() => props.onDelete(true)}
      >
        Ripple delete
      </Button>
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Undo"
        title="Undo (⌘Z)"
        disabled={!props.canUndo}
        onClick={props.onUndo}
      >
        <Undo2Icon aria-hidden />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Redo"
        title="Redo (⇧⌘Z)"
        disabled={!props.canRedo}
        onClick={props.onRedo}
      >
        <Redo2Icon aria-hidden />
      </Button>
    </div>
  );
}
