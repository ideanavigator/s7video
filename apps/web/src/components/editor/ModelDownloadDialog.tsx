// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The question before the speech model downloads (S7V-026, ADR-006). It only shows state: the
// Transcript tab (S7V-030) opens it when the user asks to transcribe and no model is downloaded,
// and wires the answers to transcribe.models.download / .dismiss and the download's engine job
// (progress and cancel through engine.jobs.*). Nothing opens it unasked.
import type { TranscribeModel, TranscribeModelsStatus } from "@t3tools/contracts";
import { useId, useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";

export type ModelDownloadState =
  | { readonly phase: "asking" }
  | { readonly phase: "downloading"; readonly progress: number }
  | { readonly phase: "failed"; readonly message: string };

/** Decimal gigabytes, as download sizes are usually given: 3744329895 bytes is "3.7 GB". */
function formatGigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

const CHOICES: ReadonlyArray<{
  readonly model: TranscribeModel;
  readonly label: string;
  readonly hint: string;
}> = [
  { model: "default", label: "Standard", hint: "The most accurate." },
  { model: "light", label: "Light", hint: "Smaller and faster, a few more mistakes." },
];

export function ModelDownloadDialog(props: {
  readonly open: boolean;
  readonly status: TranscribeModelsStatus;
  readonly state: ModelDownloadState;
  readonly onDownload: (model: TranscribeModel) => void;
  readonly onCancelDownload: () => void;
  readonly onDismiss: () => void;
}) {
  const id = useId();
  const [model, setModel] = useState<TranscribeModel>(props.status.recommended);
  const size = formatGigabytes(props.status.profiles[model].sizeBytes);
  const { state } = props;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && state.phase !== "downloading") props.onDismiss();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Download the speech model?</DialogTitle>
          <DialogDescription>
            {APP_BASE_NAME} needs to download its speech model, about {size}. It stays on this Mac,
            and transcription then works without internet.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.phase === "downloading" ? (
            <div className="flex flex-col gap-2">
              <div
                role="progressbar"
                aria-label="Speech model download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(state.progress * 100)}
                aria-valuetext={`${Math.round(state.progress * 100)}% of ${size}`}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(state.progress * 100)}%` }}
                />
              </div>
              <p className="text-muted-foreground text-sm">
                {Math.round(state.progress * 100)}% of {size}. You can keep working; the download
                continues where it stopped if it is interrupted.
              </p>
            </div>
          ) : (
            <RadioGroup
              aria-label="Speech model"
              value={model}
              onValueChange={(value) => {
                if (value === "default" || value === "light") setModel(value);
              }}
            >
              {CHOICES.map((choice) => (
                <div key={choice.model} className="flex items-start gap-3">
                  <Radio id={`${id}-${choice.model}`} value={choice.model} />
                  <Label htmlFor={`${id}-${choice.model}`}>
                    <span className="flex flex-col gap-0.5">
                      <span>
                        {choice.label},{" "}
                        {formatGigabytes(props.status.profiles[choice.model].sizeBytes)}
                      </span>
                      <span className="text-muted-foreground text-sm">{choice.hint}</span>
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}
          {state.phase === "failed" ? (
            <p role="alert" className="mt-3 text-destructive text-sm">
              {state.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {state.phase === "downloading" ? (
            <Button variant="outline" onClick={props.onCancelDownload}>
              Cancel download
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={props.onDismiss}>
                Not now
              </Button>
              <Button onClick={() => props.onDownload(model)}>
                {state.phase === "failed" ? "Try again" : `Download ${size}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
