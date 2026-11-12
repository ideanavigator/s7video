// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// "Export for editors" (S7V-040): pick the editor's format and a captions file, see what won't
// carry over, then Continue or Cancel. The list comes from the engine, as the job's result does.
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EngineJobId,
  InterchangeCaptions,
  InterchangeFormat,
  InterchangeExportResult,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { editEnvironment } from "../../editor/editStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";

const INTERCHANGE_CHOICES: ReadonlyArray<{
  readonly format: InterchangeFormat;
  readonly title: string;
  readonly detail: string;
}> = [
  { format: "fcpxml", title: "Final Cut Pro", detail: "FCPXML" },
  {
    format: "otio",
    title: "Premiere or DaVinci Resolve",
    detail: "OpenTimelineIO, keeps the most",
  },
  { format: "fcp7xml", title: "Final Cut 7 and older editors", detail: "FCP7 XML" },
  { format: "edl", title: "EDL", detail: "CMX 3600, picture cuts only" },
];

const CAPTION_CHOICES: ReadonlyArray<{
  readonly captions: InterchangeCaptions;
  readonly title: string;
}> = [
  { captions: "srt", title: "SRT (opens in most editors)" },
  { captions: "ass", title: "ASS (keeps the caption look)" },
  { captions: "none", title: "No captions file" },
];

interface Choice {
  readonly format: InterchangeFormat;
  readonly captions: InterchangeCaptions;
}

/** The review and the export use the choice that was checked, never one changed since. */
type Step =
  | { readonly kind: "choose" }
  | { readonly kind: "checking" }
  | { readonly kind: "review"; readonly choice: Choice; readonly dropped: ReadonlyArray<string> }
  | { readonly kind: "starting"; readonly choice: Choice; readonly dropped: ReadonlyArray<string> };

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Check the project, then try again.";

export function ExportForEditorsDialog(props: {
  readonly projectRef: ScopedProjectRef;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onStarted: (started: { readonly jobId: EngineJobId; readonly path: string }) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      {props.open && <ExportChoice {...props} />}
    </Dialog>
  );
}

function ExportChoice(props: {
  readonly projectRef: ScopedProjectRef;
  readonly onClose: () => void;
  readonly onStarted: (started: { readonly jobId: EngineJobId; readonly path: string }) => void;
}) {
  const { environmentId, projectId } = props.projectRef;
  const run = useAtomCommand(editEnvironment.exportInterchange, { reportFailure: false });
  const [format, setFormat] = useState<InterchangeFormat>("fcpxml");
  const [captions, setCaptions] = useState<InterchangeCaptions>("srt");
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [error, setError] = useState<string | null>(null);
  const formatLabel = useId();
  const captionsLabel = useId();
  const droppedLabel = useId();

  const request = async (choice: Choice, check: boolean) => {
    setError(null);
    const result = await run({
      environmentId,
      input: { projectId, ...choice, ...(check ? { check } : {}) },
    });
    if (result._tag === "Failure") {
      setError(errorText(squashAtomCommandFailure(result)));
      return null;
    }
    return result.value satisfies InterchangeExportResult;
  };

  const review = async () => {
    const choice = { format, captions };
    setStep({ kind: "checking" });
    const checked = await request(choice, true);
    setStep(
      checked === null ? { kind: "choose" } : { kind: "review", choice, dropped: checked.dropped },
    );
  };

  const start = async (choice: Choice, dropped: ReadonlyArray<string>) => {
    setStep({ kind: "starting", choice, dropped });
    const started = await request(choice, false);
    if (started === null || started.jobId === undefined) {
      setStep({ kind: "review", choice, dropped });
      return;
    }
    props.onStarted({ jobId: started.jobId, path: started.files.join(", ") });
    props.onClose();
  };

  const checking = step.kind === "checking";
  const reviewed = step.kind === "review" || step.kind === "starting" ? step.choice : null;
  const shownFormat = reviewed?.format ?? format;
  const choice = INTERCHANGE_CHOICES.find((entry) => entry.format === shownFormat);
  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>Export for editors</DialogTitle>
        <DialogDescription>
          The cuts land where they are here. The files go in the project's exports folder and use
          your original media.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {step.kind === "review" || step.kind === "starting" ? (
          <div className="space-y-2 text-sm">
            <p id={droppedLabel} className="font-medium">
              {step.dropped.length === 0
                ? `Everything carries over to ${choice?.title ?? "the editor"}.`
                : `What won't carry over to ${choice?.title ?? "the editor"}:`}
            </p>
            {step.dropped.length > 0 && (
              <ul aria-labelledby={droppedLabel} className="list-disc space-y-1 ps-5">
                {step.dropped.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <span id={formatLabel} className="block text-sm font-medium">
                Your editor
              </span>
              <RadioGroup
                aria-labelledby={formatLabel}
                value={format}
                disabled={checking}
                onValueChange={(next) => setFormat(next as InterchangeFormat)}
              >
                {INTERCHANGE_CHOICES.map((entry) => (
                  <label
                    key={entry.format}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm"
                  >
                    <Radio value={entry.format} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{entry.title}</span>
                      <span className="block text-muted-foreground">{entry.detail}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </div>
            <div className="space-y-2">
              <span id={captionsLabel} className="block text-sm font-medium">
                Captions file
              </span>
              <RadioGroup
                aria-labelledby={captionsLabel}
                value={captions}
                disabled={checking}
                onValueChange={(next) => setCaptions(next as InterchangeCaptions)}
              >
                {CAPTION_CHOICES.map((entry) => (
                  <label
                    key={entry.captions}
                    className="flex cursor-pointer items-center gap-2.5 text-sm"
                  >
                    <Radio value={entry.captions} />
                    {entry.title}
                  </label>
                ))}
              </RadioGroup>
            </div>
          </div>
        )}
        {error !== null && (
          <div className="mt-3">
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" size="sm" onClick={props.onClose}>
          Cancel
        </Button>
        {step.kind === "review" || step.kind === "starting" ? (
          <Button
            size="sm"
            disabled={step.kind === "starting"}
            onClick={() => void start(step.choice, step.dropped)}
          >
            {step.kind === "starting" && <Spinner aria-hidden />}
            Continue
          </Button>
        ) : (
          <Button size="sm" disabled={step.kind === "checking"} onClick={() => void review()}>
            {step.kind === "checking" && <Spinner aria-hidden />}
            Next
          </Button>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}
