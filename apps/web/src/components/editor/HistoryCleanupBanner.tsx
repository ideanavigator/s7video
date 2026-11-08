// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * S7V-050: once the edit history is big, the same question the assistant asks in chat. Nothing is
 * removed without a click; "Remove all" first says how much it frees and that undo starts again.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EditSnapshot, ScopedProjectRef } from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import { editEnvironment } from "../../editor/editStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Megabytes with one decimal, as the assistant's question says them. */
const historyMegabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const versionsText = (count: number) => `${count} old version${count === 1 ? "" : "s"}`;

export function HistoryCleanupBanner(props: {
  readonly projectRef: ScopedProjectRef;
  readonly snapshot: EditSnapshot | null;
}) {
  const { environmentId, projectId } = props.projectRef;
  const clean = useAtomCommand(editEnvironment.historyClean, { reportFailure: false });
  const dismiss = useAtomCommand(editEnvironment.historyDismiss, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  // null: closed; "measuring": open, waiting for the dry run; a number: the bytes it frees.
  const [confirm, setConfirm] = useState<null | "measuring" | number>(null);
  const cleanup = props.snapshot?.cleanup;
  if (cleanup === undefined) return null;

  const failed = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Nothing was removed. Try again.",
    });
  };

  const keepRecent = async () => {
    setBusy(true);
    const result = await clean({ environmentId, input: { projectId, mode: "keep-recent" } });
    setBusy(false);
    if (result._tag === "Failure") return failed("Couldn't tidy up old versions", result);
    toastManager.add({
      type: "success",
      title: `Removed ${versionsText(result.value.removedVersions)}`,
      description: `Freed ${historyMegabytes(result.value.freedBytes)}. Your clips are not touched.`,
    });
  };

  const openRemoveAll = async () => {
    setConfirm("measuring");
    const result = await clean({
      environmentId,
      input: { projectId, mode: "remove-all", dryRun: true },
    });
    if (result._tag === "Failure") {
      setConfirm(null);
      return failed("Couldn't measure the old versions", result);
    }
    setConfirm(result.value.freedBytes);
  };

  const removeAll = async () => {
    setBusy(true);
    const result = await clean({ environmentId, input: { projectId, mode: "remove-all" } });
    setBusy(false);
    setConfirm(null);
    if (result._tag === "Failure") return failed("Couldn't remove old versions", result);
    toastManager.add({
      type: "success",
      title: "Removed all old versions",
      description: `Freed ${historyMegabytes(result.value.freedBytes)}. Undo starts again from now.`,
    });
  };

  const notNow = async () => {
    setBusy(true);
    const result = await dismiss({ environmentId, input: { projectId } });
    setBusy(false);
    if (result._tag === "Failure") failed("Couldn't save your choice", result);
  };

  return (
    <>
      <Alert variant="info" role="region" aria-label="Old versions" controlAlignment="first-line">
        <HistoryIcon aria-hidden />
        <AlertDescription>
          <p>
            This project has {cleanup.versions} saved versions ({historyMegabytes(cleanup.bytes)}).
            Keep only the last 20 (plus tagged and exported ones), or remove all old versions?
          </p>
          {/* Below the question, wrapping: the Editor panel is narrow. */}
          <div className="flex flex-wrap gap-1">
            <Button
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={() => void keepRecent()}
            >
              Keep recent
            </Button>
            <Button
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={() => void openRemoveAll()}
            >
              Remove all old versions
            </Button>
            <Button size="compact" variant="ghost" disabled={busy} onClick={() => void notNow()}>
              Not now
            </Button>
          </div>
        </AlertDescription>
      </Alert>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all old versions?</AlertDialogTitle>
            <AlertDialogDescription>
              {typeof confirm === "number"
                ? `This frees ${historyMegabytes(confirm)}. The current edit and your tagged and exported versions are kept. Undo will start again from now. Your clips are not touched.`
                : "Measuring the old versions…"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || typeof confirm !== "number"}
              onClick={() => void removeAll()}
            >
              Remove all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
