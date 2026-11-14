// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * What a finished export made (S7V-101), on its own row under the Editor's header: "Your video is
 * ready" with its length and size, and the way to it: Play the export, and Show in Finder (Open
 * in the browser build, which has no Finder). The latest video export is kept per project in
 * local storage, so it is still there after a reload.
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ExportStatus, ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CircleCheckIcon, ExternalLinkIcon, FolderOpenIcon, PlayIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAssetUrlMinter } from "../../assets/assetUrls";
import { formatPlaybackClock } from "../../editor/editPlayback";
import type { ProjectExport } from "../../editor/editStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readProject } from "../../state/entities";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const LatestExport = Schema.Struct({
  /** Relative to the project folder (`exports/…mp4`). */
  path: Schema.String,
  durationFrames: Schema.Number,
  fps: Schema.Struct({ num: Schema.Number, den: Schema.Number }),
  width: Schema.Number,
  height: Schema.Number,
});
type LatestExport = typeof LatestExport.Type;

const StoredExport = Schema.NullOr(LatestExport);

export const latestExportStorageKey = (projectRef: ScopedProjectRef) =>
  `editor-latest-export:v1:${scopedProjectKey(projectRef)}`;

const latestOf = (status: ExportStatus | null): LatestExport | null => {
  const result = status?.state === "succeeded" ? status.result : undefined;
  if (result === undefined) return null;
  const { path, durationFrames, fps, width, height } = result;
  return { path, durationFrames, fps, width, height };
};

const fileName = (path: string) => path.split("/").at(-1) ?? path;

function IconAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={props.label} onClick={props.onClick}>
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function ExportResult(props: {
  readonly projectRef: ScopedProjectRef;
  readonly projectExport: ProjectExport;
}) {
  const { projectRef } = props;
  const { job, status } = props.projectExport;
  const [stored, setStored] = useLocalStorage(
    latestExportStorageKey(projectRef),
    null,
    StoredExport,
  );
  const fresh = job?.state === "succeeded" ? latestOf(status) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the finished export in local storage, outside React, so it is still offered after a reload
  useEffect(() => {
    if (fresh !== null && fresh.path !== stored?.path) setStored(fresh);
  }, [fresh, stored, setStored]);

  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const mintUrl = useAssetUrlMinter(projectRef.environmentId);
  const [playing, setPlaying] = useState<{ readonly name: string; readonly url: string } | null>(
    null,
  );
  const isDesktop = window.desktopBridge !== undefined;

  const workspaceRoot = () => readProject(projectRef)?.workspaceRoot ?? null;
  const urlOf = async (path: string) => {
    const cwd = workspaceRoot();
    const url = cwd === null ? null : await mintUrl({ _tag: "draft-workspace-file", cwd, path });
    if (url === null) {
      toastManager.add({ type: "error", title: "Couldn't open the export", description: path });
    }
    return url;
  };
  const play = async (path: string) => {
    const url = await urlOf(path);
    if (url !== null) setPlaying({ name: fileName(path), url });
  };
  const openInBrowser = async (path: string) => {
    const url = await urlOf(path);
    if (url !== null) window.open(url, "_blank", "noopener");
  };
  const showInFinder = async (path: string) => {
    const cwd = workspaceRoot();
    const result =
      cwd === null
        ? null
        : await openInEditor({
            environmentId: projectRef.environmentId,
            input: { cwd: `${cwd}/${path}`, editor: "file-manager", reveal: true },
          });
    if (result === null || result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Couldn't show the export in Finder" });
    }
  };

  const reveal = (path: string) =>
    isDesktop ? (
      <IconAction label="Show in Finder" onClick={() => void showInFinder(path)}>
        <FolderOpenIcon aria-hidden />
      </IconAction>
    ) : null;

  const row = (() => {
    if (job?.state === "running") return null;
    if (job?.state === "cancelled") return { text: <>Export cancelled</>, tone: "muted" } as const;
    if (job?.state === "failed") {
      return {
        text: <>Export failed{status?.message ? `: ${status.message}` : ""}</>,
        tone: "error",
      } as const;
    }
    // "Export for editors" (S7V-040): its files, with the folder they are in.
    const files = job?.state === "succeeded" ? status?.files : undefined;
    if (files !== undefined && files.length > 0) {
      return {
        text: (
          <>
            Your files for editors are ready
            <span className="text-muted-foreground"> · {files.map(fileName).join(", ")}</span>
          </>
        ),
        tone: "done",
        actions: reveal(files[0]!),
      } as const;
    }
    const latest = fresh ?? stored;
    if (latest === null) return null;
    return {
      text: (
        <>
          {fresh === null ? "Latest export" : "Your video is ready"}
          <span className="text-muted-foreground tabular-nums">
            {" "}
            · {formatPlaybackClock(latest.durationFrames, latest.fps)} · {latest.width}×
            {latest.height}
          </span>
        </>
      ),
      tone: "done",
      actions: (
        <>
          <IconAction label="Play the export" onClick={() => void play(latest.path)}>
            <PlayIcon aria-hidden />
          </IconAction>
          {isDesktop ? (
            reveal(latest.path)
          ) : (
            <IconAction label="Open the export" onClick={() => void openInBrowser(latest.path)}>
              <ExternalLinkIcon aria-hidden />
            </IconAction>
          )}
        </>
      ),
    } as const;
  })();

  return (
    <>
      {row === null ? null : (
        <div
          className="flex min-h-9 shrink-0 items-center gap-2 rounded-md border bg-muted/40 py-0.5 ps-2 pe-1 text-sm"
          data-testid="export-result"
          data-tone={row.tone}
        >
          {row.tone === "done" ? (
            <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-success-foreground" />
          ) : null}
          <span
            role="status"
            className="min-w-0 flex-1 truncate data-[tone=error]:text-destructive-foreground data-[tone=muted]:text-muted-foreground"
            data-tone={row.tone}
          >
            {row.text}
          </span>
          {"actions" in row ? (
            <div className="flex shrink-0 items-center">{row.actions}</div>
          ) : null}
        </div>
      )}
      <Dialog open={playing !== null} onOpenChange={(open) => !open && setPlaying(null)}>
        {playing !== null && (
          <DialogPopup className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{playing.name}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <video
                src={playing.url}
                aria-label={`The export, ${playing.name}`}
                controls
                autoPlay
                playsInline
                className="max-h-[70vh] w-full rounded-md"
              />
            </DialogPanel>
          </DialogPopup>
        )}
      </Dialog>
    </>
  );
}
