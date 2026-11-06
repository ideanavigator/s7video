// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The speech model as a setup item (S7V-067), beside connecting an agent: in first-run setup and
 * in Settings → Providers. It shows the status and, until a model is ready, Standard or Light
 * with the server's recommendation pre-selected (ADR-006). Skipping it is fine: nothing downloads
 * without the user's press, and the Editor panel asks again when an edit needs it.
 */
import type { EnvironmentId, TranscribeModel } from "@t3tools/contracts";
import { AudioLinesIcon, CheckIcon } from "lucide-react";
import { useState } from "react";

import { anySpeechModelReady, useSpeechModelStatus } from "../../editor/editStore";
import { Button } from "../ui/button";
import { formatGigabytes, foundModel, FoundOnThisMac, ModelChoice } from "./ModelDownloadDialog";
import { useModelDownload } from "./useModelDownload";

/** The engine's stage while it checks a copy found on this Mac (`models.py`). */
const REUSE_STAGE = "checking the copy on this Mac";

export function SpeechModelSetup(props: { readonly environmentId: EnvironmentId }) {
  const status = useSpeechModelStatus(props.environmentId);
  const model = useModelDownload(props.environmentId, null);
  const [choice, setChoice] = useState<TranscribeModel | null>(null);

  const ready = status !== null && anySpeechModelReady(status);
  const found = status === null || model.reuseRefused ? null : foundModel(status);
  const selected = choice ?? status?.recommended ?? "default";
  // A download started here, or one already running on this server (the panel or the agent's ask).
  const progress =
    model.state?.phase === "downloading"
      ? model.state.progress
      : model.state === null && model.job !== null
        ? model.job.progress
        : null;
  const downloading = progress !== null;
  const percent = Math.round((progress ?? 0) * 100);
  // Unknown (loading, or a server whose engine can't answer): nothing to offer yet.
  if (status === null) return null;
  const summary = ready
    ? "Ready. Transcripts, silence cuts and captions work offline."
    : downloading
      ? `${model.job?.stage === REUSE_STAGE ? "Checking the copy on this Mac" : "Downloading"}, ${percent}%. You can keep setting up.`
      : found !== null
        ? "Found on this Mac. Needed to read clips, cut silences and add captions."
        : "Not downloaded. Needed to read clips, cut silences and add captions.";

  return (
    <section
      aria-label="Speech model"
      className="rounded-lg border border-border bg-background px-4 py-4"
    >
      <div className="flex items-center gap-3">
        <AudioLinesIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Speech model</span>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{summary}</p>
        </div>
        {ready ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon aria-hidden className="size-3.5" />
            Ready
          </span>
        ) : null}
      </div>
      {ready ? null : (
        <div className="mt-4 flex flex-col gap-3 ps-8">
          {downloading ? (
            <div
              role="progressbar"
              aria-label="Speech model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
          ) : (
            <>
              {found === null ? null : (
                <FoundOnThisMac
                  found={found}
                  onUse={(copy) => void model.start(copy.model, copy.reuse)}
                />
              )}
              <ModelChoice status={status} value={selected} onChange={setChoice} />
            </>
          )}
          {model.state?.phase === "failed" ? (
            <p role="alert" className="text-destructive text-sm">
              {model.state.message}
            </p>
          ) : null}
          <div className="flex gap-2">
            {downloading ? (
              <Button size="xs" variant="outline" onClick={model.cancel}>
                Cancel download
              </Button>
            ) : (
              <Button size="xs" onClick={() => void model.start(selected)}>
                {model.state?.phase === "failed"
                  ? "Try again"
                  : `Download ${formatGigabytes(status.profiles[selected].sizeBytes)}`}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
