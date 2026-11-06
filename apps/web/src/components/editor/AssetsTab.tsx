// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's Assets tab (S7V-025): the project's clips and sounds with length, size and
 * thumbnail, import by drop or "Add media", and the missing/relink and preparing-preview states.
 * S7V-029 mounts it in the Editor panel; nothing here knows about the panel.
 */
import { LegendList } from "@legendapp/list/react";
import type {
  MediaAsset,
  MediaImporting,
  MediaImportMode,
  MediaLibrarySnapshot,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { AudioLinesIcon, FilmIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { requestConfirmDialog } from "../../confirmDialog";
import { mediaEnvironment, type MediaLibraryState, useMediaLibrary } from "../../state/media";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { BROWSER_ADD_MEDIA_HINT } from "./addMediaHint";
import { formatBytes, ImportDialog, type ImportRequest } from "./ImportDialog";
import { explanationOf } from "./mediaErrorExplanation";
import { formatMediaLength, spokenMediaLength } from "./mediaTimecode";

const ROW_HEIGHT = 60;

export interface AssetsListProps {
  readonly state: MediaLibraryState;
  /** The row's picture; the container fetches a thumbnail URL, tests pass a stand-in. */
  readonly renderThumbnail: (item: MediaAsset) => ReactNode;
  /** False in a browser without the desktop app: files can then be neither picked nor dropped. */
  readonly canAddFiles: boolean;
  readonly onAddMedia: () => void;
  readonly onDropFiles: (files: ReadonlyArray<File>) => void;
  readonly onOpen: (item: MediaAsset) => void;
  readonly onRelink: (item: MediaAsset) => void;
  readonly onRemove: (item: MediaAsset) => void;
}

const lengthOf = (item: MediaAsset, snapshot: MediaLibrarySnapshot) =>
  item.durationFrames === undefined
    ? null
    : {
        text: formatMediaLength(item.durationFrames, item.fps ?? snapshot.fps),
        spoken: spokenMediaLength(item.durationFrames, item.fps ?? snapshot.fps),
      };

const stateWords = (item: MediaAsset) =>
  item.state === "missing"
    ? "missing"
    : item.proxy.status === "preparing"
      ? "preparing preview"
      : item.proxy.status === "failed"
        ? "preview failed"
        : "ready";

function AssetRow(props: {
  readonly item: MediaAsset;
  readonly snapshot: MediaLibrarySnapshot;
  readonly thumbnail: ReactNode;
  readonly onOpen: () => void;
  readonly onRelink: () => void;
  readonly onRemove: () => void;
}) {
  const { item } = props;
  const length = lengthOf(item, props.snapshot);
  const resolution =
    item.width !== undefined && item.height !== undefined ? `${item.width}×${item.height}` : null;
  const details = [length?.text, resolution, formatBytes(item.sizeBytes)].filter(Boolean);
  const missing = item.state === "missing";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      props.onOpen();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      props.onRemove();
    }
  };
  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={[item.label, length && `length ${length.spoken}`, stateWords(item)]
        .filter(Boolean)
        .join(", ")}
      data-state={item.state}
      className="flex h-[60px] items-center gap-3 rounded-md px-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onDoubleClick={props.onOpen}
      onKeyDown={onKeyDown}
    >
      <div className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
        {props.thumbnail}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.label}</div>
        <div className="truncate text-xs text-muted-foreground tabular-nums">
          {details.join(" · ")}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.proxy.status === "preparing" && (
          <Badge variant="info" size="sm">
            Preparing preview
            {item.proxy.progress !== undefined && ` ${Math.round(item.proxy.progress * 100)}%`}
          </Badge>
        )}
        {item.proxy.status === "failed" && (
          <Badge variant="warning" size="sm">
            Preview failed
          </Badge>
        )}
        <Badge variant="outline" size="sm">
          {item.storage === "copy" ? "Copy" : "Linked"}
        </Badge>
        {missing && (
          <>
            <Badge variant="warning" size="sm">
              <TriangleAlertIcon aria-hidden />
              Missing
            </Badge>
            <Button size="xs" variant="outline" onClick={props.onRelink}>
              Relink
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ImportingRow({ entry }: { readonly entry: MediaImporting }) {
  const percent = Math.round(entry.progress * 100);
  return (
    <div
      role="status"
      className="flex h-[60px] items-center gap-3 px-2 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden />
      <span className="min-w-0 flex-1 truncate">Copying {entry.label}</span>
      <span className="tabular-nums">{percent}%</span>
    </div>
  );
}

export function AssetsList(props: AssetsListProps) {
  const [dragging, setDragging] = useState(false);
  const hintId = useId();
  const acceptsDrop = (event: DragEvent<HTMLDivElement>) =>
    props.canAddFiles && event.dataTransfer.types.includes("Files");
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    props.onDropFiles([...event.dataTransfer.files]);
  };

  const body = (() => {
    if (props.state._tag === "loading") {
      return (
        <div className="flex flex-1 items-center justify-center" role="status">
          <Spinner aria-label="Loading media" />
        </div>
      );
    }
    if (props.state._tag === "unavailable") {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Media isn't available</EmptyTitle>
            <EmptyDescription>
              This project has no video edit, or its server is offline.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    const { snapshot } = props.state;
    if (snapshot.items.length === 0 && snapshot.importing.length === 0) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FilmIcon />
            </EmptyMedia>
            <EmptyTitle>No clips yet</EmptyTitle>
            <EmptyDescription>
              {props.canAddFiles
                ? "Drop clips here or Add media. Nothing is uploaded."
                : BROWSER_ADD_MEDIA_HINT}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <>
        {snapshot.importing.map((entry) => (
          <ImportingRow key={entry.key} entry={entry} />
        ))}
        <div role="list" aria-label="Project media" className="flex min-h-0 flex-1 flex-col">
          <LegendList<MediaAsset>
            data={[...snapshot.items]}
            keyExtractor={(item) => item.id}
            estimatedItemSize={ROW_HEIGHT}
            renderItem={({ item }) => (
              <AssetRow
                item={item}
                snapshot={snapshot}
                thumbnail={props.renderThumbnail(item)}
                onOpen={() => props.onOpen(item)}
                onRelink={() => props.onRelink(item)}
                onRemove={() => props.onRemove(item)}
              />
            )}
          />
        </div>
      </>
    );
  })();

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 p-2 data-[dragging=true]:bg-accent/50"
      data-dragging={dragging}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Assets</span>
        <Button
          size="xs"
          variant="outline"
          disabled={!props.canAddFiles}
          aria-describedby={props.canAddFiles ? undefined : hintId}
          onClick={props.onAddMedia}
        >
          <PlusIcon aria-hidden />
          Add media
        </Button>
      </div>
      {props.canAddFiles ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {BROWSER_ADD_MEDIA_HINT}
        </p>
      )}
      {body}
    </div>
  );
}

function AssetThumbnail(props: {
  readonly projectRef: ScopedProjectRef;
  readonly item: MediaAsset;
}) {
  const { projectRef, item } = props;
  const url = useAssetUrlState(
    item.hasThumbnail ? projectRef.environmentId : null,
    item.hasThumbnail
      ? {
          _tag: "project-media",
          projectId: projectRef.projectId,
          mediaId: item.id,
          variant: "thumbnail",
        }
      : null,
  );
  if (url._tag === "Success") {
    return <img src={url.url} alt="" className="size-full object-cover" draggable={false} />;
  }
  return item.hasVideo ? <FilmIcon aria-hidden /> : <AudioLinesIcon aria-hidden />;
}

/** Import, relink and remove for one project; the dialog state lives here. */
export function useAssetsActions(projectRef: ScopedProjectRef) {
  const { environmentId, projectId } = projectRef;
  const plan = useAtomCommand(mediaEnvironment.plan, { reportFailure: false });
  const importMedia = useAtomCommand(mediaEnvironment.importMedia, { reportFailure: false });
  const relink = useAtomCommand(mediaEnvironment.relink, { reportFailure: false });
  const readEdit = useAtomCommand(mediaEnvironment.readEdit, { reportFailure: false });
  const applyEdit = useAtomCommand(mediaEnvironment.applyEdit, { reportFailure: false });
  const [request, setRequest] = useState<ImportRequest | null>(null);

  const offerImport = async (paths: ReadonlyArray<string>) => {
    if (paths.length === 0) return;
    const planned = await plan({ environmentId, input: { projectId, sourcePaths: paths } });
    if (planned._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Couldn't add media",
        description: explanationOf(planned),
      });
      return;
    }
    setRequest({ paths, plan: planned.value });
  };

  const confirmImport = async (mode: MediaImportMode) => {
    const paths = request?.paths ?? [];
    setRequest(null);
    for (const sourcePath of paths) {
      const result = await importMedia({ environmentId, input: { projectId, sourcePath, mode } });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: `Couldn't add ${sourcePath.split(/[\\/]/u).at(-1)}`,
          description: explanationOf(result),
        });
      }
    }
  };

  const pickFiles = async (multiple: boolean) =>
    (await window.desktopBridge?.pickMediaFiles({ multiple })) ?? [];

  const relinkItem = async (item: MediaAsset) => {
    const [sourcePath] = await pickFiles(false);
    if (sourcePath === undefined) return;
    const result = await relink({
      environmentId,
      input: { projectId, mediaId: item.id, sourcePath },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Couldn't relink",
        description: explanationOf(result),
      });
    }
  };

  const removeItem = async (item: MediaAsset) => {
    const confirmed =
      (await requestConfirmDialog(
        `Remove "${item.label}" from this project? The original file is not deleted.`,
        { variant: "destructive" },
      )) ?? false;
    if (!confirmed) return;
    const current = await readEdit({ environmentId, input: { projectId } });
    const result =
      current._tag === "Failure"
        ? current
        : await applyEdit({
            environmentId,
            input: {
              projectId,
              baseRevision: current.value.revision,
              origin: "timeline",
              ops: [{ _tag: "removeMedia", mediaId: item.id }],
            },
          });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Couldn't remove",
        description: explanationOf(result),
      });
    }
  };

  return {
    request,
    cancelImport: () => setRequest(null),
    confirmImport,
    addMedia: async () => offerImport(await pickFiles(true)),
    addFiles: (files: ReadonlyArray<File>) => {
      const getPath = window.desktopBridge?.getPathForFile;
      void offerImport(getPath ? files.map((file) => getPath(file)).filter(Boolean) : []);
    },
    relinkItem,
    removeItem,
  };
}

export function AssetsTab(props: {
  readonly projectRef: ScopedProjectRef;
  /** Enter on a row: the Editor plays that clip. */
  readonly onOpenMedia?: (mediaId: string) => void;
}) {
  const state = useMediaLibrary(props.projectRef);
  const actions = useAssetsActions(props.projectRef);
  return (
    <>
      <AssetsList
        state={state}
        canAddFiles={window.desktopBridge !== undefined}
        renderThumbnail={(item) => <AssetThumbnail projectRef={props.projectRef} item={item} />}
        onAddMedia={() => void actions.addMedia()}
        onDropFiles={actions.addFiles}
        onOpen={(item) => props.onOpenMedia?.(item.id)}
        onRelink={(item) => void actions.relinkItem(item)}
        onRemove={(item) => void actions.removeItem(item)}
      />
      <ImportDialog
        request={actions.request}
        onConfirm={(mode) => void actions.confirmImport(mode)}
        onCancel={actions.cancelImport}
      />
    </>
  );
}
