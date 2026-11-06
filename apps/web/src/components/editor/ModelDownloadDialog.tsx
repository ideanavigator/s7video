// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The question before the speech model downloads (S7V-026, ADR-006). It only shows state: the
// Transcript tab (S7V-030) and the Editor panel's prompt (S7V-067) open it when the user asks,
// and wire the answers through useModelDownload. Nothing opens it unasked.
import type {
  TranscribeModel,
  TranscribeModelsDownloadInput,
  TranscribeModelsStatus,
} from "@t3tools/contracts";
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
  | {
      readonly phase: "downloading";
      readonly progress: number;
      /** Checking a copy found on this Mac rather than downloading (S7V-067). */
      readonly checking?: boolean;
    }
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

export interface FoundModel {
  readonly model: TranscribeModel;
  readonly copyBytes: number;
  readonly reuse: NonNullable<TranscribeModelsDownloadInput["reuse"]>;
}

/** A copy on this Mac to use instead of downloading (S7V-067): the recommended model's first. */
export function foundModel(status: TranscribeModelsStatus): FoundModel | null {
  const order: ReadonlyArray<TranscribeModel> =
    status.recommended === "light" ? ["light", "default"] : ["default", "light"];
  for (const model of order) {
    const found = status.profiles[model].found;
    if (found !== undefined && !status.profiles[model].ready) {
      return { model, copyBytes: found.copyBytes, reuse: found.copyBytes > 0 ? "copy" : "clone" };
    }
  }
  return null;
}

/** "Found on this Mac, ready to use", with Use; using it still needs the press. */
export function FoundOnThisMac(props: {
  readonly found: FoundModel;
  readonly onUse: (found: FoundModel) => void;
}) {
  const { found } = props;
  const label = CHOICES.find((choice) => choice.model === found.model)?.label ?? found.model;
  return (
    <div className="flex items-start gap-3 rounded-md border border-border p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Found on this Mac, ready to use</p>
        <p className="text-muted-foreground text-sm">
          {found.copyBytes > 0
            ? `The ${label} model is on another disk, so using it copies ${formatGigabytes(found.copyBytes)}. Every file is checked first.`
            : `The ${label} model is already on this Mac, so nothing downloads and it takes no extra space. Every file is checked first.`}
        </p>
      </div>
      <Button size="sm" onClick={() => props.onUse(found)}>
        Use
      </Button>
    </div>
  );
}

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
  /** Use a copy found on this Mac; omitted (or `found` refused) hides the offer. */
  readonly onUse?: (found: FoundModel) => void;
  readonly hideFound?: boolean;
  readonly onCancelDownload: () => void;
  readonly onDismiss: () => void;
}) {
  const [model, setModel] = useState<TranscribeModel>(props.status.recommended);
  const size = formatGigabytes(props.status.profiles[model].sizeBytes);
  const { state } = props;
  const found = props.onUse && !props.hideFound ? foundModel(props.status) : null;
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
                aria-label={
                  state.checking ? "Checking the speech model copy" : "Speech model download"
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(state.progress * 100)}
                aria-valuetext={`${Math.round(state.progress * 100)}% ${state.checking ? "checked" : `of ${size}`}`}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(state.progress * 100)}%` }}
                />
              </div>
              <p className="text-muted-foreground text-sm">
                {state.checking
                  ? `Checking the copy on this Mac, ${Math.round(state.progress * 100)}%. Every file is compared with the pinned model before it is used; nothing downloads.`
                  : `${Math.round(state.progress * 100)}% of ${size}. You can keep working; the download continues where it stopped if it is interrupted.`}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {found !== null && props.onUse ? (
                <FoundOnThisMac found={found} onUse={props.onUse} />
              ) : null}
              <ModelChoice status={props.status} value={model} onChange={setModel} />
            </div>
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
