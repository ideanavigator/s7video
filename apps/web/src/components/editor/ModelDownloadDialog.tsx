// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The question before the speech model downloads (S7V-026, ADR-006). It only shows state: the
// Transcript tab (S7V-030) and the Editor panel's prompt (S7V-067) open it when the user asks,
// and wire the answers through useModelDownload. Nothing opens it unasked.
import type { TranscribeModel, TranscribeModelsStatus } from "@t3tools/contracts";
import { useId, useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { Badge } from "../ui/badge";
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
export function formatGigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

const CHOICES: ReadonlyArray<{
  readonly model: TranscribeModel;
  readonly label: string;
  readonly hint: string;
}> = [
  { model: "default", label: "Standard", hint: "The most accurate." },
  {
    model: "light",
    label: "Light",
    hint: "Smaller and faster, a few more mistakes. Suits Macs with 8 GB of memory or less.",
  },
];

/** Standard or Light with their sizes; the server's recommendation (ADR-006) is marked. */
export function ModelChoice(props: {
  readonly status: TranscribeModelsStatus;
  readonly value: TranscribeModel;
  readonly onChange: (model: TranscribeModel) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <RadioGroup
      aria-label="Speech model"
      value={props.value}
      disabled={props.disabled ?? false}
      onValueChange={(value) => {
        if (value === "default" || value === "light") props.onChange(value);
      }}
    >
      {CHOICES.map((choice) => (
        <div key={choice.model} className="flex items-start gap-3">
          <Radio id={`${id}-${choice.model}`} value={choice.model} />
          <Label htmlFor={`${id}-${choice.model}`}>
            <span className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5">
                <span>
                  {choice.label}, {formatGigabytes(props.status.profiles[choice.model].sizeBytes)}
                </span>
                {props.status.recommended === choice.model ? (
                  <Badge variant="secondary" size="sm">
                    Recommended
                  </Badge>
                ) : null}
              </span>
              <span className="text-muted-foreground text-sm">{choice.hint}</span>
            </span>
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}

export function ModelDownloadDialog(props: {
  readonly open: boolean;
  readonly status: TranscribeModelsStatus;
  readonly state: ModelDownloadState;
  readonly onDownload: (model: TranscribeModel) => void;
  readonly onCancelDownload: () => void;
  readonly onDismiss: () => void;
}) {
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
            <ModelChoice status={props.status} value={model} onChange={setModel} />
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
