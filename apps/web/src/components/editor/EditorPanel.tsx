// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor right-panel kind (S7V-029): the player over the project's edit, with Versions
 * (S7V-069), Transcript and Media tabs below and Export in the header. A video dropped anywhere on
 * it is imported (S7V-076). The panel belongs to a thread; the edit belongs to
 * the project, so every thread of a project shows the same edit.
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EditOp,
  type EditSnapshot,
  type EngineJobId,
  type EnvironmentId,
  ExportStartError,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClapperboardIcon,
  FilmIcon,
  PlayIcon,
  PlusIcon,
  SendToBackIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
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
  type ProjectExport,
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
import { observeResize } from "../../lib/observeResize";
import { useMediaLibrary, type MediaLibraryState } from "../../state/media";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BROWSER_ADD_MEDIA_HINT } from "./addMediaHint";
import { AssetsTab, useAssetsActions } from "./AssetsTab";
import { CaptionOverlay } from "./CaptionOverlay";
import { EditPlayer } from "./EditPlayer";
import { ExportForEditorsDialog } from "./ExportForEditorsDialog";
import { useExportResult } from "./ExportResult";
import { IconAction } from "./IconAction";
import { HistoryCleanupBanner } from "./HistoryCleanupBanner";
import { ImportDialog } from "./ImportDialog";
import { MultiClipPlayer, type MultiClipSource } from "./MultiClipPlayer";
import { SpeechModelPrompt } from "./SpeechModelPrompt";
import { applyOutcomeOfError, stepOutcomeOfError } from "../../editor/timelineEditing";
import { editFrameToPlayerFrame } from "./timeline/editFrames";
import type { TimelineEditing } from "./timeline/Timeline";
import type { EditApplyOutcome, TimelineNotice } from "./timeline/timelineEditor";
import { TIMELINE_FLOOR_PX, TIMELINE_SHORTEST_PX, TimelinePane } from "./timeline/TimelinePane";
import { cn } from "../../lib/utils";
import { type TranscriptEditing, TranscriptTab } from "./TranscriptTab";
import { VersionsTab } from "./VersionsTab";

type EditorTab = "versions" | "transcript" | "media";

const MAX_AUTOMATIC_RETRIES = 1;

const TABS: ReadonlyArray<{ readonly id: EditorTab; readonly label: string }> = [
  { id: "versions", label: "Versions" },
  { id: "transcript", label: "Transcript" },
  { id: "media", label: "Media" },
];

export const DROP_OVERLAY_TEXT = "Drop to add to this project. Nothing is uploaded.";

/**
 * The player gets space first (UX guide rule 3, S7V-101): its picture never gets shorter than this
 * share of the Editor. Banners and the tabs shrink and the timeline scrolls before it does.
 */
export const PLAYER_SHARE = 0.45;
/** The player's controls under the picture, with their gap. */
const PLAYER_CONTROLS_PX = 30;
/** The panel's padding on each axis. */
const PANEL_PADDING_PX = 16;
/** One version row with its gap (`VersionsTab`): the tabs show whole rows of this. */
const TAB_ROW_PX = 62;
const TAB_BAR_PX = 30;
/** The gaps around the player, the tab bar, the divider and the timeline; the tab room adds one. */
const COLUMN_GAPS_PX = 4 * 8;
const GAP_PX = 8;

interface PanelSize {
  readonly width: number;
  readonly height: number;
}

/** The player area's least and most height: its share of the panel, and its canvas at full width. */
function playerRoomPx(
  panel: PanelSize,
  canvas: { readonly width: number; readonly height: number } | undefined,
): { readonly min: number; readonly max: number | undefined } {
  const min = Math.ceil(PLAYER_SHARE * panel.height) + PLAYER_CONTROLS_PX;
  if (canvas === undefined) return { min, max: undefined };
  const fullWidth = ((panel.width - PANEL_PADDING_PX) * canvas.height) / canvas.width;
  return { min, max: Math.max(min, Math.ceil(fullWidth) + PLAYER_CONTROLS_PX) };
}

/**
 * What the tab room starts from (S7V-101): one whole version row when the timeline can still keep
 * its floor beside the player's share; otherwise none, and the tab bar says why.
 */
function tabsMinPx(panelHeight: number, topPx: number, playerMinPx: number): number {
  const spare =
    panelHeight -
    PANEL_PADDING_PX -
    topPx -
    playerMinPx -
    TAB_BAR_PX -
    COLUMN_GAPS_PX -
    GAP_PX -
    TIMELINE_FLOOR_PX;
  return spare >= TAB_ROW_PX ? TAB_ROW_PX : 0;
}

const NOTICE_GAP_PX = 8;
/** The "Show N more notices" line under the notices that fit. */
const NOTICE_CUE_PX = 24;

/**
 * How many notices show whole (S7V-101): from the top, as many as fit in `roomPx` with the cue
 * line when some are left out. The first one shows anyway when it is urgent (a refused change).
 */
function fitNotices(
  heights: ReadonlyArray<number>,
  roomPx: number,
  urgentFirst: boolean,
): { readonly shown: number; readonly heightPx: number } {
  let shown = 0;
  let heightPx = 0;
  for (const height of heights) {
    const next = heightPx + (shown > 0 ? NOTICE_GAP_PX : 0) + height;
    const cue = shown + 1 < heights.length ? NOTICE_CUE_PX + NOTICE_GAP_PX : 0;
    if (next + cue > roomPx && !(shown === 0 && urgentFirst)) break;
    heightPx = next;
    shown += 1;
  }
  return { shown, heightPx };
}

function PlayerMessage(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  /** Lets a control below point at the description (`aria-describedby`). */
  readonly descriptionId?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center overflow-y-auto rounded-md bg-muted/40">
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
        className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted/40"
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
      overlay={view.mode === "edit" ? <CaptionOverlay projectRef={projectRef} /> : null}
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
        overlay={<CaptionOverlay projectRef={projectRef} />}
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
  const hintId = useId();
  switch (view._tag) {
    case "loading":
      return (
        <div
          role="status"
          aria-label="Loading the edit"
          className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted/40"
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
        <div className="flex min-h-0 flex-1 flex-col rounded-md">
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
  readonly editing: TranscriptEditing | undefined;
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
    <TranscriptTab
      projectRef={props.projectRef}
      editing={props.editing}
      {...timelineTranscriptPlayback(plan, index)}
    />
  );
}

const isExportStartError = Schema.is(ExportStartError);
const isNoTranscript = (error: unknown) =>
  isExportStartError(error) && error.reason === "no-transcript";

interface StartedExport {
  readonly jobId: EngineJobId;
  readonly path: string;
}

function ExportButton(props: {
  readonly projectRef: ScopedProjectRef;
  readonly projectExport: ProjectExport;
  readonly started: StartedExport | null;
  readonly onStarted: (started: StartedExport) => void;
}) {
  const { environmentId, projectId } = props.projectRef;
  const start = useAtomCommand(editEnvironment.exportStart, { reportFailure: false });
  const cancel = useAtomCommand(editEnvironment.cancelJob, { reportFailure: false });
  const { started, onStarted: setStarted } = props;
  const { job } = props.projectExport;
  // Started but not yet in the jobs stream counts as running.
  const running = job?.state === "running" || (started !== null && job === null);
  const progress = Math.round((job?.progress ?? 0) * 100);
  // Set from the click until the job stops running, so a repeat click can't resend the cancel.
  const [cancellingJobId, setCancellingJobId] = useState<EngineJobId | null>(null);
  const cancelling = cancellingJobId !== null && cancellingJobId === (job?.id ?? started?.jobId);
  const [editorsOpen, setEditorsOpen] = useState(false);

  const exportEdit = async (captions?: false) => {
    const result = await start({
      environmentId,
      input: captions === false ? { projectId, captions } : { projectId },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      const toastId = toastManager.add({
        type: "error",
        title: "Couldn't start the export",
        description: error instanceof Error ? error.message : "Check the project, then try again.",
        // Captions stay on by default; without a transcript the user can still export, uncaptioned.
        ...(isNoTranscript(error)
          ? {
              actionProps: {
                children: "Export without captions",
                // The export starts, so "Couldn't start" goes (S7V-101).
                onClick: () => {
                  toastManager.close(toastId);
                  void exportEdit(false);
                },
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

  return (
    <>
      <ExportForEditorsDialog
        projectRef={props.projectRef}
        open={editorsOpen}
        onClose={() => setEditorsOpen(false)}
        onStarted={setStarted}
      />
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
          <>
            <Button size="compact" variant="outline" onClick={() => void exportEdit()}>
              <UploadIcon aria-hidden />
              Export
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label="Export for editors"
                    onClick={() => setEditorsOpen(true)}
                  >
                    <SendToBackIcon aria-hidden />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">Export for editors</TooltipPopup>
            </Tooltip>
          </>
        )}
      </div>
    </>
  );
}

/** The notice when the edit changed under a gesture (S7V-034 AC-7). */
export const CHANGED_ELSEWHERE_NOTICE = "The assistant changed the edit; try again.";

function showTimelineNotice(notice: TimelineNotice) {
  if (notice.kind === "changed-elsewhere") {
    toastManager.add({ type: "info", title: CHANGED_ELSEWHERE_NOTICE });
  } else if (notice.kind === "refused") {
    toastManager.add({ type: "info", title: notice.message, timeout: 4000 });
  } else {
    toastManager.add({ type: "error", title: notice.title, description: notice.message });
  }
}

/** `edit.apply` as an edit outcome, for the timeline and the transcript alike. */
function useEditApply(projectRef: ScopedProjectRef, origin: "timeline" | "transcript") {
  const apply = useAtomCommand(editEnvironment.apply, { reportFailure: false });
  const { environmentId, projectId } = projectRef;
  return async (ops: ReadonlyArray<EditOp>, baseRevision: number): Promise<EditApplyOutcome> => {
    const result = await apply({
      environmentId,
      input: { projectId, baseRevision, origin, ops: [...ops] },
    });
    return result._tag === "Success"
      ? { _tag: "applied", revision: result.value.revision }
      : applyOutcomeOfError(squashAtomCommandFailure(result));
  };
}

/** Timeline edits go through `edit.apply`/`undo`/`redo`, origin `timeline` (S7V-034). */
function useTimelineEditing(
  projectRef: ScopedProjectRef,
  snapshot: EditSnapshot | null,
  enabled: boolean,
): TimelineEditing | undefined {
  const apply = useEditApply(projectRef, "timeline");
  const undo = useAtomCommand(editEnvironment.undo, { reportFailure: false });
  const redo = useAtomCommand(editEnvironment.redo, { reportFailure: false });
  const { environmentId, projectId } = projectRef;
  if (snapshot === null || !enabled) return undefined;
  const step = async (run: typeof undo) => {
    const result = await run({ environmentId, input: { projectId } });
    return result._tag === "Success"
      ? ({ _tag: "applied", revision: result.value.revision } as const)
      : stepOutcomeOfError(squashAtomCommandFailure(result));
  };
  return {
    revision: snapshot.revision,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    actions: {
      apply,
      undo: () => step(undo),
      redo: () => step(redo),
      notify: showTimelineNotice,
    },
  };
}

/** Text edits from the Transcript tab, origin `transcript` (S7V-038), on the edit as it plays. */
function useTranscriptEditing(
  projectRef: ScopedProjectRef,
  snapshot: EditSnapshot | null,
  enabled: boolean,
): TranscriptEditing | undefined {
  const apply = useEditApply(projectRef, "transcript");
  if (snapshot === null || !enabled) return undefined;
  return { document: snapshot.document, revision: snapshot.revision, apply };
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
  const [tab, setTab] = useState<EditorTab>("versions");
  const [panelSize, setPanelSize] = useState<PanelSize | null>(null);
  const observePanel = (element: HTMLDivElement | null) =>
    element === null
      ? undefined
      : observeResize(element, () =>
          setPanelSize((current) =>
            current?.width === element.clientWidth && current.height === element.clientHeight
              ? current
              : { width: element.clientWidth, height: element.clientHeight },
          ),
        );
  // The header, the export row and the notices (S7V-101), and whether anything closable is up.
  const [top, setTop] = useState({ px: 0, closable: false, aboveNoticesPx: 0 });
  const observeTop = (element: HTMLDivElement | null) =>
    element === null
      ? undefined
      : observeResize(element, () => {
          const closable = [...element.children]
            .slice(1)
            .some((child) => child.getBoundingClientRect().height > 0);
          const group = element.querySelector<HTMLElement>("[data-testid=editor-notices-group]");
          const aboveNoticesPx = group === null ? 0 : group.offsetTop - element.offsetTop;
          setTop((current) =>
            current.px === element.offsetHeight &&
            current.closable === closable &&
            current.aboveNoticesPx === aboveNoticesPx
              ? current
              : { px: element.offsetHeight, closable, aboveNoticesPx },
          );
        });
  const topPx = top.px;
  // The notices up, in order, each with its own height, measured unclipped.
  const [notices, setNotices] = useState<{
    readonly keys: ReadonlyArray<string>;
    readonly heights: ReadonlyArray<number>;
  }>({ keys: [], heights: [] });
  const observeNotices = (element: HTMLDivElement | null) =>
    element === null
      ? undefined
      : observeResize(element, () => {
          const up = [...element.children].filter(
            (child): child is HTMLElement => child instanceof HTMLElement && child.offsetHeight > 0,
          );
          const keys = up.map((child) => child.dataset.notice ?? "");
          const heights = up.map((child) => child.offsetHeight);
          setNotices((current) =>
            current.keys.join() === keys.join() && current.heights.join() === heights.join()
              ? current
              : { keys, heights },
          );
        });
  const [noticesOpen, setNoticesOpen] = useState(false);
  // The room the tabs got; a panel shows whole rows of it, or the hint under one row.
  const [tabRoomPx, setTabRoomPx] = useState<number | null>(null);
  const observeTabRoom = (element: HTMLDivElement | null) =>
    element === null ? undefined : observeResize(element, () => setTabRoomPx(element.clientHeight));
  const [startedExport, setStartedExport] = useState<StartedExport | null>(null);
  const projectExport = useProjectExport(
    props.environmentId,
    props.projectId,
    startedExport?.jobId ?? null,
  );
  const exportResult = useExportResult({ projectRef, projectExport });
  const canAddFiles = window.desktopBridge !== undefined;
  const [dragging, setDragging] = useState(false);
  const acceptsDrop = (event: DragEvent<HTMLDivElement>) =>
    canAddFiles && event.dataTransfer.types.includes("Files");
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // Moving onto a child fires a leave too; only leaving the panel ends the drag.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    // The Media list imports its own drops.
    if (!acceptsDrop(event) || event.defaultPrevented) return;
    event.preventDefault();
    actions.addFiles([...event.dataTransfer.files]);
  };
  const view = playerViewOf(edit, library, source);
  const playerRoom =
    panelSize === null
      ? null
      : playerRoomPx(
          panelSize,
          view._tag === "play" || view._tag === "play-timeline" ? view.plan.canvas : undefined,
        );
  const tabsMin =
    panelSize === null || playerRoom === null
      ? TAB_ROW_PX
      : tabsMinPx(panelSize.height, topPx, playerRoom.min);
  const tabsCollapsed = tabsMin < TAB_ROW_PX;
  // The top block never takes the timeline's toolbar and ruler: past this, its notices scroll.
  // The notices take what the player's share and the timeline leave: closed, the timeline keeps
  // its video row; opened, only its toolbar and ruler. Whole notices only, the urgent one first.
  const noticeRoom = (keepPx: number) =>
    panelSize === null || playerRoom === null
      ? Number.POSITIVE_INFINITY
      : panelSize.height -
        PANEL_PADDING_PX -
        playerRoom.min -
        TAB_BAR_PX -
        COLUMN_GAPS_PX -
        top.aboveNoticesPx -
        keepPx;
  const urgentFirst = notices.keys[0] === "refused";
  const closedFit = fitNotices(notices.heights, noticeRoom(TIMELINE_FLOOR_PX), urgentFirst);
  const noticesFit = closedFit.shown === notices.heights.length;
  const fit =
    noticesFit || !noticesOpen
      ? closedFit
      : fitNotices(notices.heights, noticeRoom(TIMELINE_SHORTEST_PX), urgentFirst);
  const noticesLeft = notices.heights.length - fit.shown;
  /** A notice out of view is clipped at a notice boundary and kept out of the Tab order. */
  const noticeOutOfView = (key: string) => {
    const at = notices.keys.indexOf(key);
    return !noticesFit && at >= fit.shown;
  };
  // Opened and every notice in view, the cue goes too: its room is better spent on a notice.
  const showNoticesCue = !noticesFit && (!noticesOpen || noticesLeft > 0);
  const tabPanelStyle = {
    height:
      tabRoomPx === null || tabRoomPx < TAB_ROW_PX
        ? undefined
        : Math.floor(tabRoomPx / TAB_ROW_PX) * TAB_ROW_PX,
  };
  const tabLabel = TABS.find((entry) => entry.id === tab)?.label ?? "this";

  const showEdit = () => {
    rememberPlayerFrame(projectKey, 0);
    setSource(projectKey, { kind: "edit" });
  };

  const previewingClip = view._tag === "play" && view.mode === "clip";
  const previewingVersion = source.kind === "version" ? source.n : null;
  const playingPlan: PlayerFramePlan | null =
    previewingVersion !== null
      ? null
      : view._tag === "play-timeline"
        ? view.plan
        : view._tag === "play" && view.mode === "edit"
          ? view.plan
          : null;
  // A click while a clip previews goes back to the edit, at the clicked frame. A frame past the
  // edit's end moves only the timeline's playhead.
  const seekFromTimeline = (editFrame: number) => {
    if (source.kind !== "edit") {
      rememberPlayerFrame(projectKey, editFrame);
      setSource(projectKey, { kind: "edit" });
      return;
    }
    const frame = editFrameToPlayerFrame(editFrame, playingPlan);
    if (frame === null) return;
    rememberPlayerFrame(projectKey, frame);
    requestPlayerSeek(projectKey, frame);
  };
  // While vN previews, the timeline still shows the main edit: it is read-only, and a press goes back to main.
  const editing = useTimelineEditing(
    projectRef,
    edit._tag === "ready" ? edit.snapshot : null,
    previewingVersion === null,
  );
  // Words are edited only on the edit itself: not while a clip or an older version is previewed.
  const transcriptEditing = useTranscriptEditing(
    projectRef,
    edit._tag === "ready" ? edit.snapshot : null,
    source.kind === "edit" &&
      (view._tag === "play-timeline" ||
        view._tag === "all-cut" ||
        (view._tag === "play" && view.mode === "edit")),
  );
  const mediaById = new Map(
    library._tag === "ready" ? library.snapshot.items.map((item) => [item.id, item] as const) : [],
  );

  return (
    <div
      ref={observePanel}
      className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2"
      data-testid="editor-panel"
      // The Editor owns its keys: S, Delete and Mod+Z never reach the chat composer (S7V-101).
      data-editor-keys
      data-dragging={dragging}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-ring bg-background/85 p-4 text-center text-sm font-medium"
        >
          {DROP_OVERLAY_TEXT}
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">
        {dragging ? DROP_OVERLAY_TEXT : ""}
      </div>
      <div ref={observeTop} className="flex shrink-0 flex-col gap-2" data-testid="editor-top">
        <div className="flex min-h-7 shrink-0 items-center justify-between gap-2">
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
            {previewingVersion !== null ? (
              <>
                <span role="status" className="min-w-0 truncate text-muted-foreground">
                  Previewing v{previewingVersion}
                </span>
                <Button size="compact" variant="ghost" onClick={showEdit}>
                  Back to main
                </Button>
              </>
            ) : null}
          </div>
          {edit._tag === "ready" &&
          previewingVersion === null &&
          (view._tag === "play-timeline" || (view._tag === "play" && view.mode === "edit")) ? (
            <div className="flex min-w-0 items-center gap-2">
              <CaptionStylePicker projectRef={projectRef} document={edit.snapshot.document} />
              {exportResult.playHidden === null ? null : (
                // The hidden export row's way back, so the latest export stays reachable.
                <IconAction label="Play the latest export" onClick={exportResult.playHidden}>
                  <PlayIcon aria-hidden />
                </IconAction>
              )}
              <ExportButton
                projectRef={projectRef}
                projectExport={projectExport}
                started={startedExport}
                onStarted={setStartedExport}
              />
            </div>
          ) : null}
        </div>
        {exportResult.row}
        {/*
          The one to read now comes first. Only whole notices show; the rest wait behind
          "Show N more notices", and once opened, behind "Close one to see N more".
        */}
        <div
          className="flex flex-col [&:not(:has([data-notice]:not(:empty)))]:hidden"
          data-testid="editor-notices-group"
        >
          <div
            className="overflow-hidden"
            style={{ maxHeight: noticesFit ? undefined : fit.heightPx }}
            data-testid="editor-notices-scroller"
          >
            <div ref={observeNotices} className="flex flex-col gap-2" data-testid="editor-notices">
              <div
                data-notice="refused"
                className="empty:hidden"
                inert={noticeOutOfView("refused")}
              >
                <RefusedChangeNotice snapshot={edit._tag === "ready" ? edit.snapshot : null} />
              </div>
              <div
                data-notice="old-versions"
                className="empty:hidden"
                inert={noticeOutOfView("old-versions")}
              >
                <HistoryCleanupBanner
                  projectRef={projectRef}
                  snapshot={edit._tag === "ready" ? edit.snapshot : null}
                />
              </div>
              <div
                data-notice="speech-model"
                className="empty:hidden"
                inert={noticeOutOfView("speech-model")}
              >
                <SpeechModelPrompt projectRef={projectRef} />
              </div>
            </div>
          </div>
          {showNoticesCue ? (
            <div
              className={cn("flex h-6 items-center gap-2 text-xs", fit.shown > 0 && "mt-2")}
              data-testid="editor-notices-cue"
            >
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={noticesOpen}
                onClick={() => setNoticesOpen((open) => !open)}
              >
                {noticesOpen ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
                {noticesOpen
                  ? "Show fewer notices"
                  : `Show ${noticesLeft} more ${noticesLeft === 1 ? "notice" : "notices"}`}
              </Button>
              {noticesOpen && noticesLeft > 0 ? (
                <span className="text-muted-foreground">Close one to see {noticesLeft} more.</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {exportResult.dialog}
      {/*
        The player takes the room first, in its canvas shape, and keeps its share of the panel. It
        grows far ahead of the tabs, so they get only what is left once its canvas fills the width.
      */}
      <div
        className="flex min-h-0 flex-col"
        style={{
          flex: "1000 0 0%",
          minHeight: playerRoom?.min,
          maxHeight: playerRoom?.max,
        }}
        data-testid="editor-player-area"
      >
        <PlayerArea projectRef={projectRef} view={view} actions={actions} />
      </div>
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
        {tabsCollapsed ? (
          <p
            className="ml-auto line-clamp-2 min-w-0 self-center ps-2 text-end text-xs leading-3.5 text-muted-foreground"
            data-testid="editor-tabs-hint"
          >
            {top.closable
              ? `Close a notice above or make the window taller to see ${tabLabel}.`
              : `Make the window taller to see ${tabLabel}.`}
          </p>
        ) : null}
      </div>
      {/*
        The tab room: whole rows of the active tab, or one plain line when not even one row fits.
        Every tab stays mounted, so each keeps its scroll position.
      */}
      <div
        ref={observeTabRoom}
        hidden={tabsCollapsed}
        className={tabsCollapsed ? "hidden" : "flex min-h-0 flex-col"}
        style={{ flex: "1 1 0%", minHeight: tabsMin }}
        data-testid="editor-tab-room"
      >
        <div
          role="tabpanel"
          id="editor-tabpanel-transcript"
          aria-labelledby="editor-tab-transcript"
          hidden={tab !== "transcript"}
          className="min-h-0"
          style={tabPanelStyle}
        >
          {view._tag === "play-timeline" ? (
            <TimelineTranscriptTab
              projectRef={projectRef}
              plan={view.plan}
              editing={transcriptEditing}
            />
          ) : (
            <TranscriptTab
              projectRef={projectRef}
              editing={transcriptEditing}
              {...transcriptSourceOf(view, library, edit)}
            />
          )}
        </div>
        <div
          role="tabpanel"
          id="editor-tabpanel-media"
          aria-labelledby="editor-tab-media"
          hidden={tab !== "media"}
          className="min-h-0"
          style={tabPanelStyle}
        >
          <AssetsTab
            projectRef={projectRef}
            onOpenMedia={(mediaId) => {
              rememberPlayerFrame(projectKey, 0);
              setSource(projectKey, { kind: "clip", mediaId });
            }}
          />
        </div>
        <div
          role="tabpanel"
          id="editor-tabpanel-versions"
          aria-labelledby="editor-tab-versions"
          hidden={tab !== "versions"}
          className="min-h-0"
          style={tabPanelStyle}
        >
          <VersionsTab
            projectRef={projectRef}
            previewing={previewingVersion}
            onPreview={(n, document) => {
              rememberPlayerFrame(projectKey, 0);
              setSource(projectKey, { kind: "version", n, document });
            }}
            onShowCurrent={showEdit}
          />
        </div>
      </div>
      {edit._tag === "unavailable" ? null : (
        <TimelinePane
          projectKey={projectKey}
          document={edit._tag === "ready" ? edit.snapshot.document : null}
          playheadVisible={!previewingClip && previewingVersion === null}
          initialFrame={rememberedPlayerFrame(projectKey)}
          onSeek={seekFromTimeline}
          plan={playingPlan}
          projectRef={projectRef}
          mediaById={mediaById}
          editing={editing}
          minAbovePx={
            playerRoom === null
              ? undefined
              : PANEL_PADDING_PX +
                topPx +
                playerRoom.min +
                TAB_BAR_PX +
                COLUMN_GAPS_PX +
                (tabsCollapsed ? 0 : GAP_PX + tabsMin)
          }
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
