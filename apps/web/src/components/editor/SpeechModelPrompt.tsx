// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's speech model prompt (S7V-067): while no model is downloaded it asks at the
 * top of the panel, so the user finds what the assistant asked for without the Transcript tab.
 * After "Not now" (kept by the server) it stays away until the assistant asks again. The download
 * still needs a yes, in the dialog.
 */
import type { ScopedProjectRef, TranscribeModel } from "@t3tools/contracts";
import { AudioLinesIcon, DownloadIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  anySpeechModelReady,
  useSpeechModelRequests,
  useSpeechModelStatus,
} from "../../editor/editStore";
import { toastManager } from "../ui/toast";
import { IconAction } from "./IconAction";
import { type FoundModel, ModelDownloadDialog } from "./ModelDownloadDialog";
import { REUSE_STAGE, useModelDownload } from "./useModelDownload";

export const SPEECH_MODEL_PROMPT = "The assistant needs the speech model to read your clip";

export function SpeechModelPrompt(props: { readonly projectRef: ScopedProjectRef }) {
  const { environmentId, projectId } = props.projectRef;
  const status = useSpeechModelStatus(environmentId);
  const requested = useSpeechModelRequests((state) => state.requested[environmentId] === true);
  const model = useModelDownload(environmentId, projectId);
  const [open, setOpen] = useState(false);

  if (status === null || anySpeechModelReady(status)) return null;
  if (status.consent === "dismissed" && !requested && !open) return null;

  const take = async (choice: TranscribeModel, reuse?: FoundModel["reuse"]) => {
    const outcome = await model.start(choice, reuse);
    if (outcome === "failed") return;
    setOpen(false);
    if (outcome === "downloaded") {
      toastManager.add({
        type: "success",
        title: "Speech model ready",
        description: "Ask the assistant to go on with your edit.",
      });
    }
  };

  const running = model.job !== null && model.state === null;
  const checking = model.job?.stage === REUSE_STAGE;
  const progress = Math.round((model.job?.progress ?? 0) * 100);

  return (
    // One line (S7V-101, the layout part of audit finding 8), so it never squeezes the player.
    <div
      role="region"
      aria-label="Speech model"
      className="flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-info/32 bg-info/4 py-0.5 ps-2.5 pe-1 text-sm"
    >
      <AudioLinesIcon aria-hidden className="size-4 shrink-0 text-info" />
      <span className="min-w-0 flex-1 truncate">
        {running ? (
          <>
            <span>
              {checking
                ? "Checking the speech model copy on this Mac…"
                : "Downloading the speech model…"}
            </span>{" "}
            <span className="text-muted-foreground tabular-nums">
              {progress}% {checking ? "checked" : "downloaded"}
            </span>
          </>
        ) : (
          SPEECH_MODEL_PROMPT
        )}
      </span>
      {running ? null : (
        <>
          <IconAction
            label="Download the speech model (once)"
            onClick={() => {
              model.reset();
              setOpen(true);
            }}
          >
            <DownloadIcon aria-hidden />
          </IconAction>
          <IconAction label="Not now" onClick={() => void model.notNow()}>
            <XIcon aria-hidden />
          </IconAction>
        </>
      )}
      {open ? (
        <ModelDownloadDialog
          open
          status={status}
          state={model.state ?? { phase: "asking" }}
          onDownload={(choice) => void take(choice)}
          onUse={(found) => void take(found.model, found.reuse)}
          hideFound={model.reuseRefused}
          onCancelDownload={model.cancel}
          onDismiss={() => {
            setOpen(false);
            void model.notNow();
          }}
        />
      ) : null}
    </div>
  );
}
