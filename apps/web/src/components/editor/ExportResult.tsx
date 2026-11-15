// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * What a finished export made (S7V-101, S7V-109), on its own row under the Editor's header, with
 * the way to it: Play and Show in Finder (Open, or for files for editors their folder, where the
 * server can't show files). The latest export is kept per project in local storage, so it is
 * still there after a reload, until the user hides it or the file goes.
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ExportStatus, ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAssetUrlMinter } from "../../assets/assetUrls";
import { formatPlaybackClock } from "../../editor/editPlayback";
import type { ProjectExport } from "../../editor/editStore";
import {
  formatFileSize,
  isExportPath,
  useCanRevealFiles,
  useExportFileCheck,
  useExportFileSize,
  useWorkspaceRoot,
} from "../../editor/exportFiles";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { IconAction } from "./IconAction";

const LatestExport = Schema.Struct({
  /** Relative to the project folder (`exports/…mp4`); anything else is dropped. */
  path: Schema.String,
  durationFrames: Schema.Number,
  fps: Schema.Struct({ num: Schema.Number, den: Schema.Number }),
  width: Schema.Number,
  height: Schema.Number,
  /** The user hid the row; the next export shows again. */
  hidden: Schema.optionalKey(Schema.Boolean),
});
type LatestExport = typeof LatestExport.Type;

const StoredExport = Schema.NullOr(LatestExport);

export const latestExportStorageKey = (projectRef: ScopedProjectRef) =>
  `editor-latest-export:v1:${scopedProjectKey(projectRef)}`;

/**
 * The latest files for editors (S7V-109), beside the video export's entry: newer than the kept
 * video export while it is set, since a video export clears it.
 */
const LatestEditorsFiles = Schema.Struct({
  /** Each relative to the project folder (`exports/…`); a list naming anything else is dropped. */
  files: Schema.Array(Schema.String),
  hidden: Schema.optionalKey(Schema.Boolean),
});
type LatestEditorsFiles = typeof LatestEditorsFiles.Type;

const StoredEditorsFiles = Schema.NullOr(LatestEditorsFiles);

export const latestEditorsFilesStorageKey = (projectRef: ScopedProjectRef) =>
  `editor-latest-editors-files:v1:${scopedProjectKey(projectRef)}`;

const exportFiles = (files: ReadonlyArray<string> | undefined) =>
  files !== undefined && files.length > 0 && files.every(isExportPath) ? files : null;

export const EXPORT_GONE = "That export was moved or deleted.";

const latestOf = (status: ExportStatus | null): LatestExport | null => {
  const result = status?.state === "succeeded" ? status.result : undefined;
  if (result === undefined || !isExportPath(result.path)) return null;
  const { path, durationFrames, fps, width, height } = result;
  return { path, durationFrames, fps, width, height };
};

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** "edit.fcpxml and .srt": one export's files share a name, so the rest are named by type. */
const filesText = (files: ReadonlyArray<string>) => {
  const [first, ...rest] = files.map(fileName);
  const stem = first!.replace(/\.[^.]+$/u, "");
  const names = [
    first!,
    ...rest.map((name) => (name.startsWith(`${stem}.`) ? name.slice(stem.length) : name)),
  ];
  return names.length < 2 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** The project's own exports folder, where every export's files are. */
const EXPORTS_FOLDER = "exports";

export interface ExportResultParts {
  /** The row under the header, or null. */
  readonly row: ReactNode;
  /** The Play dialog; render it anywhere. */
  readonly dialog: ReactNode;
  /** Plays the latest export after its row was hidden, so it stays reachable; else null. */
  readonly playHidden: (() => void) | null;
}

export function useExportResult(props: {
  readonly projectRef: ScopedProjectRef;
  readonly projectExport: ProjectExport;
}): ExportResultParts {
  const { projectRef } = props;
  const { environmentId } = projectRef;
  const { job, status } = props.projectExport;
  const [rawStored, setStored] = useLocalStorage(
    latestExportStorageKey(projectRef),
    null,
    StoredExport,
  );
  const stored = rawStored !== null && isExportPath(rawStored.path) ? rawStored : null;
  const fresh = job?.state === "succeeded" ? latestOf(status) : null;
  const latest = fresh ?? stored;
  const workspaceRoot = useWorkspaceRoot(projectRef);
  const absolute = (path: string) => (workspaceRoot === null ? null : `${workspaceRoot}/${path}`);
  const size = useExportFileSize(
    environmentId,
    latest === null || job?.state === "running" ? null : absolute(latest.path),
  );
  // A kept export whose file is gone, or a kept path that names anything outside exports/, goes.
  const storedGone = stored !== null && fresh === null && size === "missing";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the finished export in local storage, outside React, so it is still offered after a reload
  useEffect(() => {
    if (fresh !== null && fresh.path !== rawStored?.path) setStored(fresh);
    else if (rawStored !== null && (stored === null || storedGone)) setStored(null);
  }, [fresh, rawStored, stored, storedGone, setStored]);

  // The files for editors (S7V-109), kept the same way; the first is the timeline file.
  const [rawEditors, setEditors] = useLocalStorage(
    latestEditorsFilesStorageKey(projectRef),
    null,
    StoredEditorsFiles,
  );
  const storedFiles = exportFiles(rawEditors?.files);
  const freshFiles = job?.state === "succeeded" ? exportFiles(status?.files) : null;
  const editorsFiles = freshFiles ?? (fresh === null ? storedFiles : null);
  const editorsSize = useExportFileSize(
    environmentId,
    editorsFiles === null || job?.state === "running" ? null : absolute(editorsFiles[0]!),
  );
  const editorsGone = freshFiles === null && storedFiles !== null && editorsSize === "missing";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the finished files for editors in local storage, outside React, so they are still offered after a reload
  useEffect(() => {
    const sameFiles = (files: ReadonlyArray<string>) =>
      rawEditors !== null && files.join("\n") === rawEditors.files.join("\n");
    if (freshFiles !== null && !sameFiles(freshFiles)) setEditors({ files: [...freshFiles] });
    // A newer video export, a kept list naming anything outside exports/, or a gone file.
    else if (rawEditors !== null && (fresh !== null || storedFiles === null || editorsGone)) {
      setEditors(null);
    }
  }, [freshFiles, fresh, rawEditors, storedFiles, editorsGone, setEditors]);

  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const mintUrl = useAssetUrlMinter(environmentId);
  const checkFile = useExportFileCheck(environmentId);
  const canReveal = useCanRevealFiles(environmentId) && window.desktopBridge !== undefined;
  const [playing, setPlaying] = useState<{
    readonly latest: LatestExport;
    readonly url: string;
  } | null>(null);

  /** The file's absolute path when it is still there; otherwise says so and forgets it. */
  const present = async (path: string): Promise<string | null> => {
    const file = isExportPath(path) ? absolute(path) : null;
    if (file === null) {
      toastManager.add({ type: "error", title: "Couldn't open the export", description: path });
      return null;
    }
    if ((await checkFile(file)) === "missing") {
      if (stored?.path === path) setStored(null);
      toastManager.add({ type: "error", title: EXPORT_GONE });
      return null;
    }
    return file;
  };
  const urlOf = async (path: string) => {
    if (workspaceRoot === null || (await present(path)) === null) return null;
    const url = await mintUrl({ _tag: "draft-workspace-file", cwd: workspaceRoot, path });
    if (url === null) {
      toastManager.add({ type: "error", title: "Couldn't open the export", description: path });
    }
    return url;
  };
  const play = async (shown: LatestExport) => {
    const url = await urlOf(shown.path);
    if (url !== null) setPlaying({ latest: shown, url });
  };
  const openInBrowser = async (path: string) => {
    const url = await urlOf(path);
    if (url !== null) window.open(url, "_blank", "noopener");
  };
  const showInFinder = async (path: string) => {
    const file = await present(path);
    if (file === null) return;
    const result = await openInEditor({
      environmentId,
      input: { cwd: file, editor: "file-manager", reveal: true },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Couldn't show the export in Finder" });
    }
  };
  const hide = (shown: LatestExport) => setStored({ ...shown, hidden: true });
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: (folder: string) =>
      toastManager.add({
        type: "success",
        title: "Copied where your files for editors are",
        description: folder,
      }),
    onError: () =>
      toastManager.add({ type: "error", title: "Couldn't copy the folder's location" }),
  });
  const latestHidden =
    latest !== null &&
    (fresh === null
      ? latest.hidden === true
      : rawStored?.path === latest.path && rawStored.hidden === true);

  const reveal = (path: string) =>
    canReveal ? (
      <IconAction label="Show in Finder" onClick={() => void showInFinder(path)}>
        <FolderOpenIcon aria-hidden />
      </IconAction>
    ) : (
      <IconAction label="Open the export" onClick={() => void openInBrowser(path)}>
        <ExternalLinkIcon aria-hidden />
      </IconAction>
    );

  // A cancelled or failed outcome row hides for this session only; files for editors stay hidden.
  const [hiddenOutcome, setHiddenOutcome] = useState<string | null>(null);
  const hideOutcome = (
    <IconAction label="Hide" onClick={() => setHiddenOutcome(job?.id ?? null)}>
      <XIcon aria-hidden />
    </IconAction>
  );
  const outcomeHidden = job !== null && hiddenOutcome === job.id;

  const row = (() => {
    if (job?.state === "running") return null;
    if (outcomeHidden && job?.state !== "succeeded") return null;
    if (job?.state === "cancelled") {
      return { text: <>Export cancelled</>, tone: "muted", actions: hideOutcome } as const;
    }
    if (job?.state === "failed") {
      return {
        text: <>Export failed{status?.message ? `: ${status.message}` : ""}</>,
        tone: "error",
        actions: hideOutcome,
      } as const;
    }
    // "Export for editors" (S7V-040): its files, with Show in Finder where the server can, and
    // elsewhere the folder they are in, whose location the user can copy (S7V-109).
    if (editorsFiles !== null) {
      if (outcomeHidden || editorsGone || rawEditors?.hidden === true) return null;
      const first = editorsFiles[0]!;
      const folder = absolute(EXPORTS_FOLDER);
      return {
        text: (
          <>
            {freshFiles === null ? "Latest files for editors" : "Your files for editors are ready"}
            <span className="text-muted-foreground">
              {` · ${canReveal ? "" : "in exports: "}${filesText(editorsFiles)}`}
            </span>
          </>
        ),
        tone: "done",
        // The names are where to find the files, so they wrap rather than being cut off.
        wraps: true,
        actions: (
          <>
            {canReveal ? (
              reveal(first)
            ) : folder === null ? null : (
              <IconAction
                label="Copy where the files are"
                onClick={() => copyToClipboard(folder, folder)}
              >
                <CopyIcon aria-hidden />
              </IconAction>
            )}
            <IconAction
              label="Hide"
              onClick={() => {
                setHiddenOutcome(job?.id ?? null);
                setEditors({ files: [...editorsFiles], hidden: true });
              }}
            >
              <XIcon aria-hidden />
            </IconAction>
          </>
        ),
      } as const;
    }
    if (latest === null || storedGone || latestHidden) return null;
    const sizeText = typeof size === "number" ? ` · ${formatFileSize(size)}` : "";
    return {
      text: (
        <>
          {fresh === null ? "Latest export" : "Your video is ready"}
          <span className="text-muted-foreground tabular-nums">
            {` · ${formatPlaybackClock(latest.durationFrames, latest.fps)} · ${latest.width}×${latest.height}${sizeText}`}
          </span>
        </>
      ),
      tone: "done",
      showsLatest: true,
      actions: (
        <>
          <IconAction label="Play the export" onClick={() => void play(latest)}>
            <PlayIcon aria-hidden />
          </IconAction>
          {reveal(latest.path)}
          <IconAction label="Hide" onClick={() => hide(latest)}>
            <XIcon aria-hidden />
          </IconAction>
        </>
      ),
    } as const;
  })();

  const rowNode =
    row === null ? null : (
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
          className={`min-w-0 flex-1 ${"wraps" in row ? "break-words py-1" : "truncate"} data-[tone=error]:text-destructive-foreground data-[tone=muted]:text-muted-foreground`}
          data-tone={row.tone}
        >
          {row.text}
        </span>
        {"actions" in row && row.actions !== null ? (
          <div className="flex shrink-0 items-center">{row.actions}</div>
        ) : null}
      </div>
    );
  const dialog = (
    <Dialog open={playing !== null} onOpenChange={(open) => !open && setPlaying(null)}>
      {playing !== null && (
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Your export · {formatPlaybackClock(playing.latest.durationFrames, playing.latest.fps)}
            </DialogTitle>
            <DialogDescription>
              {playing.latest.width}×{playing.latest.height}, saved as{" "}
              {fileName(playing.latest.path)}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <video
              src={playing.url}
              aria-label="Your export"
              controls
              autoPlay
              playsInline
              className="max-h-[65vh] w-full rounded-md"
            />
          </DialogPanel>
        </DialogPopup>
      )}
    </Dialog>
  );
  const showsLatest = row !== null && "showsLatest" in row;
  // The latest video export stays reachable whenever the row isn't showing it: hidden, or an
  // outcome row (a failed or cancelled export, files for editors) took its place.
  const playHidden =
    latest !== null && !showsLatest && !storedGone && job?.state !== "running"
      ? () => void play(latest)
      : null;
  return { row: rowNode, dialog, playHidden };
}
