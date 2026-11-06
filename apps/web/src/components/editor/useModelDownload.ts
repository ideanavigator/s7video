// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The speech model download the user said yes to (S7V-026), shared by every place that asks:
 * the Transcript tab, the Editor panel's prompt and the setup card (S7V-067). It starts
 * `transcribe.models.download`, follows the engine job for progress, cancels it, and records
 * "Not now". It never starts a download by itself.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  TranscribeModel,
  TranscribeModelsDownloadInput,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import {
  editEnvironment,
  refreshSpeechModelStatus,
  useSpeechModelRequests,
  useTranscriptionJobs,
} from "../../editor/editStore";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ModelDownloadState } from "./ModelDownloadDialog";

export const commandErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback;

export const engineErrorReason = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "EngineError" &&
  "reason" in error
    ? error.reason
    : null;

/** The engine job's stage while it checks a copy found on this Mac (`models.py`). */
export const REUSE_STAGE = "checking the copy on this Mac";

export type ModelDownloadOutcome = "downloaded" | "cancelled" | "failed";

export function useModelDownload(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const download = useAtomCommand(editEnvironment.modelsDownload, { reportFailure: false });
  const dismiss = useAtomCommand(editEnvironment.modelsDismiss, { reportFailure: false });
  const cancel = useAtomCommand(editEnvironment.cancelJob, { reportFailure: false });
  const job = useTranscriptionJobs(environmentId, projectId).download;
  const [state, setState] = useState<ModelDownloadState | null>(null);
  // A found copy that failed its check is not offered again; the normal download still is.
  const [reuseRefused, setReuseRefused] = useState(false);
  // A Cancel pressed before the download's job is in the jobs stream waits here for its id.
  const cancelQueued = useRef(false);
  const cancelRequested = useRef(false);
  const jobId = job?.id ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends a queued cancel to the server once the download's job id arrives in the jobs stream
  useEffect(() => {
    if (!cancelQueued.current || jobId === null) return;
    cancelQueued.current = false;
    void cancel({ environmentId, input: { jobId } });
  }, [cancel, jobId, environmentId]);

  const answered = () => {
    useSpeechModelRequests.getState().clear(environmentId);
    refreshSpeechModelStatus(environmentId);
  };

  const start = async (
    model: TranscribeModel,
    reuse?: TranscribeModelsDownloadInput["reuse"],
  ): Promise<ModelDownloadOutcome> => {
    cancelRequested.current = false;
    setState({ phase: "downloading", progress: 0 });
    const result = await download({
      environmentId,
      input: {
        model,
        ...(projectId === null ? {} : { projectId }),
        ...(reuse === undefined ? {} : { reuse }),
      },
    });
    cancelQueued.current = false;
    if (cancelRequested.current) {
      // Cancelled, or finished just as the user cancelled: either way, nothing follows now.
      setState(null);
      refreshSpeechModelStatus(environmentId);
      return "cancelled";
    }
    if (result._tag === "Success") {
      setState(null);
      answered();
      return "downloaded";
    }
    const error = squashAtomCommandFailure(result);
    if (engineErrorReason(error) === "cancelled") {
      setState(null);
      return "cancelled";
    }
    if (reuse !== undefined) setReuseRefused(true);
    setState({ phase: "failed", message: commandErrorMessage(error, "The download stopped.") });
    return "failed";
  };

  const cancelDownload = () => {
    cancelRequested.current = true;
    if (jobId === null) cancelQueued.current = true;
    else void cancel({ environmentId, input: { jobId } });
  };

  const notNow = async () => {
    setState(null);
    await dismiss({ environmentId, input: {} });
    answered();
  };

  const view: ModelDownloadState | null =
    state?.phase === "downloading"
      ? {
          phase: "downloading",
          progress: job?.progress ?? state.progress,
          checking: job?.stage === REUSE_STAGE,
        }
      : state;

  return {
    /** What this hook's download is doing; null when it started none. */
    state: view,
    /** A download running on this server, whoever started it. */
    job,
    reuseRefused,
    start,
    cancel: cancelDownload,
    notNow,
    reset: () => setState(null),
  };
}
