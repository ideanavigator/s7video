// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The caption looks beside Export (S7V-037): each look's preview, drawn by the export's own
 * libass, with its name. Picking one is one change and one undo; on an edit with no captions it
 * adds them in that look (PO 2026-11-12). The look shows over the player and in the export.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CAPTION_PRESET_NAMES,
  CaptionPresetId,
  type EditDocument,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { captionLookOf } from "@t3tools/shared/captionWords";
import { useState } from "react";

import { editEnvironment, useCaptionPresets } from "../../editor/editStore";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export function CaptionStylePicker(props: {
  readonly projectRef: ScopedProjectRef;
  readonly document: EditDocument;
}) {
  const { environmentId, projectId } = props.projectRef;
  const presets = useCaptionPresets(props.projectRef);
  const setStyle = useAtomCommand(editEnvironment.setCaptionStyle, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const current = captionLookOf(props.document);
  const previews = new Map(presets?.presets.map((preset) => [preset.id, preset.png]) ?? []);

  const pick = async (preset: CaptionPresetId) => {
    if (preset === current || picking) return;
    setPicking(true);
    const result = await setStyle({ environmentId, input: { projectId, preset } });
    setPicking(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't change the caption look",
        description: error instanceof Error ? error.message : "Check the project, then try again.",
      });
    }
  };

  return (
    <div role="group" aria-label="Caption look" className="flex min-w-0 items-center gap-1">
      {CaptionPresetId.literals.map((id) => {
        const name = CAPTION_PRESET_NAMES[id];
        const png = previews.get(id);
        const selected = id === current;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            aria-label={`Caption style: ${name}`}
            disabled={picking}
            onClick={() => void pick(id)}
            className={cn(
              "flex shrink-0 cursor-pointer flex-col items-center gap-1 rounded-md border p-1 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-64",
              selected
                ? "border-primary ring-2 ring-inset ring-primary"
                : "border-border hover:bg-accent",
            )}
          >
            {png ? (
              <img
                src={`data:image/png;base64,${png}`}
                alt=""
                className="h-5 w-auto rounded-sm"
                draggable={false}
              />
            ) : null}
            <span className="whitespace-nowrap px-0.5 text-3xs leading-none text-muted-foreground">
              {name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
