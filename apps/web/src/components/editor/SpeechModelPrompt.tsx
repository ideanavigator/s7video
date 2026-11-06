// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's speech model prompt (S7V-067): while no model is downloaded it asks at the
 * top of the panel, so the user finds what the assistant asked for without the Transcript tab.
 * After "Not now" it stays away until the assistant asks again. The download still needs a yes.
 */
import type { ScopedProjectRef, TranscribeModel } from "@t3tools/contracts";
import { AudioLinesIcon } from "lucide-react";
import { useState } from "react";

import {
  anySpeechModelReady,
  useSpeechModelRequests,
  useSpeechModelStatus,
} from "../../editor/editStore";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { type FoundModel, ModelDownloadDialog } from "./ModelDownloadDialog";
import { useModelDownload } from "./useModelDownload";

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
  const progress = Math.round((model.job?.progress ?? 0) * 100);

  return (
    <div className="shrink-0">
      <Alert variant="info">
        <AudioLinesIcon aria-hidden />
        <AlertTitle>
          {running
            ? "Downloading the speech model…"
            : "The assistant needs the speech model to read your clip"}
        </AlertTitle>
        <AlertDescription>
          {running
            ? `${progress}% downloaded. Edits that need it can go ahead when it's done.`
            : "Cutting silences and captions use it. It downloads once and stays on this Mac."}
        </AlertDescription>
        {running ? null : (
          <AlertAction>
            <Button
              size="sm"
              onClick={() => {
                model.reset();
                setOpen(true);
              }}
            >
              Download speech model
            </Button>
          </AlertAction>
        )}
      </Alert>
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
