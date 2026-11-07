// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor right-panel kind (S7V-029): the player over the project's edit, with Transcript and
 * Assets tabs below and Export in the header. The panel belongs to a thread; the edit belongs to
 * the project, so every thread of a project shows the same edit.
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EditSnapshot,
  type EngineJobId,
  type EnvironmentId,
  ExportStartError,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { ClapperboardIcon, FilmIcon, PlusIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useId, useState, type DragEvent, type ReactNode } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import {
  editEnvironment,
  rememberedPlayerFrame,
  rememberPlayerFrame,
  requestPlayerSeek,
  selectPlayerSource,
  subscribePlayerFrame,
  useEditPlayerStore,
  useProjectExport,
  useProjectEdit,
} from "../../editor/editStore";
import {
  editPlaybackPlan,
  type PlayerFramePlan,
  type TimelinePlan,
} from "../../editor/editPlayback";
import { playerViewOf, type PlayerView, type TimelineSourceView } from "../../editor/editorView";
import {
  timelineTranscriptPlayback,
  timelineTranscriptSegment,
  type TranscriptPlayback,
} from "../../editor/transcriptModel";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useMediaLibrary, type MediaLibraryState } from "../../state/media";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { BROWSER_ADD_MEDIA_HINT } from "./addMediaHint";
import { AssetsTab, useAssetsActions } from "./AssetsTab";
import { EditPlayer } from "./EditPlayer";
import { ImportDialog } from "./ImportDialog";
import { MultiClipPlayer, type MultiClipSource } from "./MultiClipPlayer";
import { SpeechModelPrompt } from "./SpeechModelPrompt";
import { editFrameToPlayerFrame } from "./timeline/editFrames";
import { TimelinePane } from "./timeline/TimelinePane";
import { TranscriptTab } from "./TranscriptTab";

type EditorTab = "transcript" | "assets";

const MAX_AUTOMATIC_RETRIES = 1;

const TABS: ReadonlyArray<{ readonly id: EditorTab; readonly label: string }> = [
  { id: "transcript", label: "Transcript" },
  { id: "assets", label: "Assets" },
];

function PlayerMessage(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  /** Lets a control below point at the description (`aria-describedby`). */
  readonly descriptionId?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex aspect-video max-h-[50vh] items-center rounded-md bg-muted/40">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription id={props.descriptionId}>{props.description}</EmptyDescription>
        </EmptyHeader>
        {props.children}
      </Empty>
    </div>
  );
}

function PlayingSource(props: {
  readonly projectRef: ScopedProjectRef;
  readonly view: Extract<PlayerView, { _tag: "play" }>;
}) {
  const { projectRef, view } = props;
  const projectKey = scopedProjectKey(projectRef);
  const [attempt, setAttempt] = useState(0);
  const [errors, setErrors] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [variant, setVariant] = useState(view.variant);
  // A proxy that finishes mid-playback takes over at the next pause, not by stopping playback.
  // A new source starts with a fresh retry, even when the old one failed to decode.
  if (variant !== view.variant && !playing) {
    setVariant(view.variant);
    setErrors(0);
  }
  const url = useAssetUrlState(
    projectRef.environmentId,
    {
      _tag: "project-media",
      projectId: projectRef.projectId,
      mediaId: view.asset.id,
      variant,
    },
    // A new revision mints a fresh URL, so an expired one recovers on retry.
    String(attempt),
  );
  const retry = () => {
    setErrors(0);
    setAttempt((current) => current + 1);
  };
  if (url._tag === "Failure" || errors > MAX_AUTOMATIC_RETRIES) {
    return (
      <PlayerMessage
        icon={<TriangleAlertIcon />}
        title="Video unavailable"
        description={
          url._tag === "Failure"
            ? `${view.asset.label} can't be opened right now.`
            : `${view.asset.label} can't be played. The file may be damaged or in a format this Mac can't play.`
        }
      >
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      </PlayerMessage>
    );
  }
  if (url._tag !== "Success") {
    return (
      <div
        role="status"
        aria-label="Loading video"
        className="flex aspect-video max-h-[50vh] items-center justify-center rounded-md bg-muted/40"
      >
        <Spinner />
      </div>
    );
  }
  return (
    <EditPlayer
      key={`${variant}:${attempt}`}
      projectKey={projectKey}
      src={url.url}
      label={view.asset.label}
      plan={view.plan}
      startFrame={rememberedPlayerFrame(projectKey)}
      onPositionChange={(frame) => rememberPlayerFrame(projectKey, frame)}
      onPlayingChange={setPlaying}
      // A source that loaded earns its quiet retry back, for the next URL expiry.
      onLoaded={() => setErrors(0)}
      onError={() => {
        setPlaying(false);
        setErrors((current) => current + 1);
        // One quiet retry covers an expired URL; a second failure shows the message.
        if (errors < MAX_AUTOMATIC_RETRIES) setAttempt((current) => current + 1);
      }}
    />
  );
}

/** Resolves one source's URL for the multi-clip player; renders nothing. */
function SourceUrl(props: {
  readonly projectRef: ScopedProjectRef;
  readonly mediaId: string;
  readonly variant: TimelineSourceView["variant"];
  readonly attempt: number;
  readonly onChange: (mediaId: string, url: string | null, failed: boolean) => void;
}) {
  const { mediaId, onChange } = props;
  const state = useAssetUrlState(
    props.projectRef.environmentId,
    {
      _tag: "project-media",
      projectId: props.projectRef.projectId,
      mediaId,
      variant: props.variant,
    },
    // A new revision mints a fresh URL, so an expired one recovers on retry.
    String(props.attempt),
  );
  const url = state._tag === "Success" ? state.url : null;
  const failed = state._tag === "Failure";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one hook per source cannot run in a loop, so each source reports its URL up to the player
  useEffect(() => onChange(mediaId, url, failed), [mediaId, url, failed, onChange]);
  return null;
}

interface SourceAttempts {
  readonly attempt: number;
  readonly errors: number;
}

/** The edit on the player clock: each source with its own URL, retry and missing state. */
function PlayingTimeline(props: {
  readonly projectRef: ScopedProjectRef;
  readonly view: Extract<PlayerView, { _tag: "play-timeline" }>;
  readonly actions: ReturnType<typeof useAssetsActions>;
}) {
  const { projectRef, view, actions } = props;
  const projectKey = scopedProjectKey(projectRef);
  const [playing, setPlaying] = useState(false);
  const [attempts, setAttempts] = useState<ReadonlyMap<string, SourceAttempts>>(new Map());
  const [urls, setUrls] = useState<ReadonlyMap<string, { url: string | null; failed: boolean }>>(
    new Map(),
  );
  // A proxy that finishes mid-playback takes over at the next pause, as in Engine A's player.
  const [variants, setVariants] = useState(
    () => new Map(view.sources.map((source) => [source.mediaId, source.variant])),
  );
  const changed = view.sources.some((source) => variants.get(source.mediaId) !== source.variant);
  if (changed && !playing) {
    setVariants(new Map(view.sources.map((source) => [source.mediaId, source.variant])));
  }
  const attemptsOf = (mediaId: string) => attempts.get(mediaId) ?? { attempt: 0, errors: 0 };
  const onUrl = useStableCallback((mediaId: string, url: string | null, failed: boolean) => {
    setUrls((current) => {
      const before = current.get(mediaId);
      if (before?.url === url && before.failed === failed) return current;
      return new Map(current).set(mediaId, { url, failed });
    });
  });
  const retry = (mediaId: string) =>
    setAttempts((current) =>
      new Map(current).set(mediaId, { attempt: attemptsOf(mediaId).attempt + 1, errors: 0 }),
    );
  const onSourceError = (mediaId: string) => {
    const { attempt, errors } = attemptsOf(mediaId);
    // One quiet retry covers an expired URL; a second failure marks the source failed.
    setAttempts((current) =>
      new Map(current).set(mediaId, {
        attempt: errors < MAX_AUTOMATIC_RETRIES ? attempt + 1 : attempt,
        errors: errors + 1,
      }),
    );
  };

  const sources = new Map<string, MultiClipSource>();
  for (const source of view.sources) {
    const { label } = source;
    const resolved = urls.get(source.mediaId);
    if (source.asset === undefined || source.asset.state === "missing") {
      sources.set(source.mediaId, { label, url: null, status: "missing" });
    } else if (resolved?.failed || attemptsOf(source.mediaId).errors > MAX_AUTOMATIC_RETRIES) {
      sources.set(source.mediaId, { label, url: null, status: "failed" });
    } else if (resolved !== undefined && resolved.url !== null) {
      sources.set(source.mediaId, { label, url: resolved.url, status: "ready" });
    } else {
      sources.set(source.mediaId, { label, url: null, status: "loading" });
    }
  }
  const stableSources = useStableSources(sources);
  const firstLabel = view.sources[0]?.label ?? "the edit";

  return (
    <>
      {view.sources.map((source) =>
        source.asset === undefined || source.asset.state === "missing" ? null : (
          <SourceUrl
            key={source.mediaId}
            projectRef={projectRef}
            mediaId={source.mediaId}
            variant={variants.get(source.mediaId) ?? source.variant}
            attempt={attemptsOf(source.mediaId).attempt}
            onChange={onUrl}
          />
        ),
      )}
      <MultiClipPlayer
        projectKey={projectKey}
        plan={view.plan}
        sources={stableSources}
        label={
          view.sources.length > 1 ? `${firstLabel} and ${view.sources.length - 1} more` : firstLabel
        }
        startFrame={rememberedPlayerFrame(projectKey)}
        onPositionChange={(frame) => rememberPlayerFrame(projectKey, frame)}
        onPlayingChange={setPlaying}
        onSourceError={onSourceError}
        renderSourceProblem={(mediaId) => {
          const source = view.sources.find((entry) => entry.mediaId === mediaId);
          const status = sources.get(mediaId)?.status;
          if (status === "failed") {
            return (
              <Button size="sm" variant="outline" onClick={() => retry(mediaId)}>
                Retry
              </Button>
            );
          }
          const asset = source?.asset;
          if (asset === undefined) return null;
          return (
            <Button
              size="sm"
              variant="outline"
              disabled={window.desktopBridge === undefined}
              onClick={() => void actions.relinkItem(asset)}
            >
              Find file…
            </Button>
          );
        }}
      />
    </>
  );
}

/** The same map object while its entries are equal, so the player's effect runs only on change. */
function useStableSources(
  next: ReadonlyMap<string, MultiClipSource>,
): ReadonlyMap<string, MultiClipSource> {
  const [kept, setKept] = useState(next);
  const same =
    kept.size === next.size &&
    [...next].every(([mediaId, source]) => {
      const other = kept.get(mediaId);
      return (
        other !== undefined &&
        other.url === source.url &&
        other.status === source.status &&
        other.label === source.label
      );
    });
  if (!same) setKept(next);
  return same ? kept : next;
}

function PlayerArea(props: {
  readonly projectRef: ScopedProjectRef;
  readonly view: PlayerView;
  readonly actions: ReturnType<typeof useAssetsActions>;
}) {
  const { view, actions } = props;
  const canAddFiles = window.desktopBridge !== undefined;
  const [dragging, setDragging] = useState(false);
  const hintId = useId();
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canAddFiles || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (!canAddFiles) return;
    event.preventDefault();
    actions.addFiles([...event.dataTransfer.files]);
  };
  switch (view._tag) {
    case "loading":
      return (
        <div
          role="status"
          aria-label="Loading the edit"
          className="flex aspect-video max-h-[50vh] items-center justify-center rounded-md bg-muted/40"
        >
          <Spinner />
        </div>
      );
    case "unavailable":
      return (
        <PlayerMessage
          icon={<ClapperboardIcon />}
          title="No edit to play"
          description={view.message}
        />
      );
    case "empty":
      return (
        <div
          className="rounded-md data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring"
          data-dragging={dragging}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <PlayerMessage
            icon={<FilmIcon />}
            title="No clips yet"
            description={
              canAddFiles ? "Drop a clip here or into the chat." : BROWSER_ADD_MEDIA_HINT
            }
            descriptionId={hintId}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={!canAddFiles}
              aria-describedby={canAddFiles ? undefined : hintId}
              onClick={() => void actions.addMedia()}
            >
              <PlusIcon aria-hidden />
              Add media
            </Button>
          </PlayerMessage>
        </div>
      );
    case "all-cut":
      return (
        <PlayerMessage
          icon={<ClapperboardIcon />}
          title="Everything is cut"
          description="Every part of the clip was removed, so there is nothing to play. Ask the agent to undo or restore a part."
        />
      );
    case "missing":
      return (
        <PlayerMessage
          icon={<TriangleAlertIcon />}
          title="Clip not found"
          description={`${view.asset.label} was moved or deleted from ${view.asset.location}.`}
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!canAddFiles}
            onClick={() => void actions.relinkItem(view.asset)}
          >
            Find file…
          </Button>
        </PlayerMessage>
      );
    case "play-timeline":
      return (
        <PlayingTimeline
          key="timeline"
          projectRef={props.projectRef}
          view={view}
          actions={actions}
        />
      );
    case "play":
      return (
        <PlayingSource
          key={`${view.mode}:${view.asset.id}`}
          projectRef={props.projectRef}
          view={view}
        />
      );
  }
}

/** The clip the Transcript tab reads, and what of it plays. */
function transcriptSourceOf(
  view: PlayerView,
  library: MediaLibraryState,
  edit: ReturnType<typeof useProjectEdit>,
): { readonly mediaId: string | null; readonly playback: TranscriptPlayback | null } {
  switch (view._tag) {
    case "play":
      return {
        mediaId: view.asset.id,
        playback: { fps: view.plan.fps, segments: view.plan.segments },
      };
    case "missing":
      return { mediaId: view.asset.id, playback: null };
    case "all-cut": {
      // The edit's own clip: every one of its words is struck.
      const document = edit._tag === "ready" ? edit.snapshot.document : null;
      const ownId =
        (document === null ? undefined : editPlaybackPlan(document)?.mediaId) ??
        document?.media.find((media) => media.kind === "video")?.id;
      const fallback =
        library._tag === "ready" ? library.snapshot.items.find((item) => item.hasVideo) : undefined;
      return {
        mediaId: ownId ?? fallback?.id ?? null,
        playback: edit._tag === "ready" ? { fps: edit.snapshot.document.fps, segments: [] } : null,
      };
    }
    default:
      return { mediaId: null, playback: null };
  }
}

/**
 * The Transcript tab over a multi-clip edit: the words of the clip on screen. It re-renders only
 * when the playhead crosses into another item, never per frame.
 */
function TimelineTranscriptTab(props: {
  readonly projectRef: ScopedProjectRef;
  readonly plan: TimelinePlan;
}) {
  const { plan } = props;
  const projectKey = scopedProjectKey(props.projectRef);
  const [segment, setSegment] = useState(() =>
    timelineTranscriptSegment(plan, rememberedPlayerFrame(projectKey)),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the player clock (outside React) to switch clips at a join
  useEffect(
    () =>
      subscribePlayerFrame(projectKey, (frame) => {
        const next = timelineTranscriptSegment(plan, frame);
        setSegment((current) => (current === next ? current : next));
      }),
    [projectKey, plan],
  );
  const index = Math.min(segment, plan.segments.length - 1);
  return (
    <TranscriptTab projectRef={props.projectRef} {...timelineTranscriptPlayback(plan, index)} />
  );
}

const isExportStartError = Schema.is(ExportStartError);
const isNoTranscript = (error: unknown) =>
  isExportStartError(error) && error.reason === "no-transcript";

function ExportButton(props: { readonly projectRef: ScopedProjectRef }) {
  const { environmentId, projectId } = props.projectRef;
  const start = useAtomCommand(editEnvironment.exportStart, { reportFailure: false });
  const cancel = useAtomCommand(editEnvironment.cancelJob, { reportFailure: false });
  const [started, setStarted] = useState<{ jobId: EngineJobId; path: string } | null>(null);
  const { job, status } = useProjectExport(environmentId, projectId, started?.jobId ?? null);
  // Started but not yet in the jobs stream counts as running.
  const running = job?.state === "running" || (started !== null && job === null);
  const progress = Math.round((job?.progress ?? 0) * 100);
  // Set from the click until the job stops running, so a repeat click can't resend the cancel.
  const [cancellingJobId, setCancellingJobId] = useState<EngineJobId | null>(null);
  const cancelling = cancellingJobId !== null && cancellingJobId === (job?.id ?? started?.jobId);

  const exportEdit = async (captions?: false) => {
    const result = await start({
      environmentId,
      input: captions === false ? { projectId, captions } : { projectId },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't start the export",
        description: error instanceof Error ? error.message : "Check the project, then try again.",
        // Captions stay on by default; without a transcript the user can still export, uncaptioned.
        ...(isNoTranscript(error)
          ? {
              actionProps: {
                children: "Export without captions",
                onClick: () => void exportEdit(false),
              },
            }
          : {}),
      });
      return;
    }
    setStarted(result.value);
  };

  const cancelExport = async () => {
    const jobId = job?.id ?? started?.jobId;
    if (jobId === undefined) return;
    setCancellingJobId(jobId);
    const result = await cancel({ environmentId, input: { jobId } });
    if (result._tag === "Failure") {
      setCancellingJobId(null);
      toastManager.add({ type: "error", title: "Couldn't cancel the export" });
    }
  };

  const outcome = (() => {
    if (running || job === null) return null;
    if (job.state === "succeeded") {
      return <>Exported to {status?.path ?? started?.path ?? "the exports folder"}</>;
    }
    if (job.state === "cancelled") return <>Export cancelled</>;
    return <>Export failed{status?.message ? `: ${status.message}` : ""}</>;
  })();

  return (
    <div className="flex min-w-0 items-center gap-2">
      {running ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div
            role="progressbar"
            aria-label="Export"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{progress}%</span>
        </div>
      ) : outcome !== null ? (
        <span
          role="status"
          className="min-w-0 truncate text-xs text-muted-foreground data-[state=failed]:text-destructive-foreground"
          data-state={job?.state}
        >
          {outcome}
        </span>
      ) : null}
      {running ? (
        <Button
          size="compact"
          variant="outline"
          aria-label="Cancel export"
          disabled={cancelling}
          onClick={() => void cancelExport()}
        >
          Cancel
        </Button>
      ) : (
        <Button size="compact" variant="outline" onClick={() => void exportEdit()}>
          <UploadIcon aria-hidden />
          Export
        </Button>
      )}
    </div>
  );
}

/** Why an outside change to the edit was not kept (S7V-054), until dismissed or the next change. */
function RefusedChangeNotice(props: { readonly snapshot: EditSnapshot | null }) {
  const [dismissed, setDismissed] = useState<EditSnapshot | null>(null);
  const { snapshot } = props;
  if (snapshot?.notice === undefined || snapshot === dismissed) return null;
  return (
    <Alert variant="warning" role="status">
      <TriangleAlertIcon aria-hidden />
      <AlertDescription>{snapshot.notice}</AlertDescription>
      <AlertAction>
        <Button size="compact" variant="ghost" onClick={() => setDismissed(snapshot)}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}

export default function EditorPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const projectRef: ScopedProjectRef = {
    environmentId: props.environmentId,
    projectId: props.projectId,
  };
  const projectKey = scopedProjectKey(projectRef);
  const edit = useProjectEdit(projectRef);
  const library = useMediaLibrary(projectRef);
  const source = useEditPlayerStore((state) =>
    selectPlayerSource(state.sourceByProjectKey, projectKey),
  );
  const setSource = useEditPlayerStore((state) => state.setSource);
  const actions = useAssetsActions(projectRef);
  const [tab, setTab] = useState<EditorTab>("assets");
  const view = playerViewOf(edit, library, source);

  const showEdit = () => {
    rememberPlayerFrame(projectKey, 0);
    setSource(projectKey, { kind: "edit" });
  };

  const previewingClip = view._tag === "play" && view.mode === "clip";
  const playingPlan: PlayerFramePlan | null =
    view._tag === "play-timeline"
      ? view.plan
      : view._tag === "play" && view.mode === "edit"
        ? view.plan
        : null;
  // A click while a clip previews goes back to the edit, at the clicked frame. A frame past the
  // edit's end moves only the timeline's playhead.
  const seekFromTimeline = (editFrame: number) => {
    if (source.kind === "clip") {
      rememberPlayerFrame(projectKey, editFrame);
      setSource(projectKey, { kind: "edit" });
      return;
    }
    const frame = editFrameToPlayerFrame(editFrame, playingPlan);
    if (frame === null) return;
    rememberPlayerFrame(projectKey, frame);
    requestPlayerSeek(projectKey, frame);
  };
  const mediaById = new Map(
    library._tag === "ready" ? library.snapshot.items.map((item) => [item.id, item] as const) : [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="editor-panel">
      <SpeechModelPrompt projectRef={projectRef} />
      <div className="flex min-h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {view._tag === "play" && view.mode === "clip" ? (
            <>
              <span className="min-w-0 truncate text-muted-foreground">
                Clip: {view.asset.label}
              </span>
              {source.kind === "clip" ? (
                <Button size="compact" variant="ghost" onClick={showEdit}>
                  Back to edit
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        {edit._tag === "ready" &&
        (view._tag === "play-timeline" || (view._tag === "play" && view.mode === "edit")) ? (
          <ExportButton projectRef={projectRef} />
        ) : null}
      </div>
      <RefusedChangeNotice snapshot={edit._tag === "ready" ? edit.snapshot : null} />
      <PlayerArea projectRef={projectRef} view={view} actions={actions} />
      <div role="tablist" aria-label="Editor views" className="flex shrink-0 gap-1 border-b">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`editor-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`editor-tabpanel-${entry.id}`}
            className="-mb-px border-b-2 border-transparent px-2 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-selected:border-primary aria-selected:text-foreground"
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {/* Both tabs stay mounted, so each keeps its scroll position. */}
      <div
        role="tabpanel"
        id="editor-tabpanel-transcript"
        aria-labelledby="editor-tab-transcript"
        hidden={tab !== "transcript"}
        className="min-h-0 flex-1"
      >
        {view._tag === "play-timeline" ? (
          <TimelineTranscriptTab projectRef={projectRef} plan={view.plan} />
        ) : (
          <TranscriptTab projectRef={projectRef} {...transcriptSourceOf(view, library, edit)} />
        )}
      </div>
      <div
        role="tabpanel"
        id="editor-tabpanel-assets"
        aria-labelledby="editor-tab-assets"
        hidden={tab !== "assets"}
        className="min-h-0 flex-1"
      >
        <AssetsTab
          projectRef={projectRef}
          onOpenMedia={(mediaId) => {
            rememberPlayerFrame(projectKey, 0);
            setSource(projectKey, { kind: "clip", mediaId });
          }}
        />
      </div>
      {edit._tag === "unavailable" ? null : (
        <TimelinePane
          projectKey={projectKey}
          document={edit._tag === "ready" ? edit.snapshot.document : null}
          playheadVisible={!previewingClip}
          initialFrame={rememberedPlayerFrame(projectKey)}
          onSeek={seekFromTimeline}
          plan={playingPlan}
          projectRef={projectRef}
          mediaById={mediaById}
        />
      )}
      <ImportDialog
        request={actions.request}
        onConfirm={(mode) => void actions.confirmImport(mode)}
        onCancel={actions.cancelImport}
      />
    </div>
  );
}
