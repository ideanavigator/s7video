// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { MediaImportMode, MediaImportPlan } from "@t3tools/contracts";
import { useId, useState } from "react";

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

export interface ImportRequest {
  /** Absolute paths on the machine the project lives on. */
  readonly paths: ReadonlyArray<string>;
  readonly plan: MediaImportPlan;
}

const fileName = (path: string) => path.split(/[\\/]/u).at(-1) ?? path;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Keep a copy or point at the file: the server's plan picks the default and says why. */
export function ImportDialog(props: {
  readonly request: ImportRequest | null;
  readonly onConfirm: (mode: MediaImportMode) => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog open={props.request !== null} onOpenChange={(open) => !open && props.onCancel()}>
      {props.request !== null && (
        <ImportChoice
          key={props.request.paths.join("\n")}
          request={props.request}
          onConfirm={props.onConfirm}
          onCancel={props.onCancel}
        />
      )}
    </Dialog>
  );
}

function ImportChoice(props: {
  readonly request: ImportRequest;
  readonly onConfirm: (mode: MediaImportMode) => void;
  readonly onCancel: () => void;
}) {
  const { paths, plan } = props.request;
  const [mode, setMode] = useState<MediaImportMode>(plan.suggestedMode);
  const labelId = useId();
  const names = paths.map(fileName);
  const shown =
    names.length <= 3
      ? names.join(", ")
      : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>{paths.length === 1 ? "Add a clip" : `Add ${paths.length} clips`}</DialogTitle>
        <DialogDescription>
          {shown} ({formatBytes(plan.totalBytes)}). Nothing is uploaded, and your file is never
          changed.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          <span id={labelId} className="sr-only">
            How to add
          </span>
          <RadioGroup
            aria-labelledby={labelId}
            value={mode}
            onValueChange={(next) => setMode(next as MediaImportMode)}
          >
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm">
              <Radio value="copy" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Keep a copy in the project</span>
                <span className="block text-muted-foreground">
                  Moving or deleting the original won't matter. Instant on the same drive.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm">
              <Radio value="reference" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Use the file where it is</span>
                <span className="block text-muted-foreground">
                  No copy. If you move the original, the clip shows as missing until you relink it.
                </span>
              </span>
            </label>
          </RadioGroup>
          {plan.reason !== undefined && (
            <Alert variant="warning">
              <AlertDescription>{plan.reason}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => props.onConfirm(mode)}>
          Add
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
