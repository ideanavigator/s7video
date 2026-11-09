// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The Editor panel's timeline (S7V-033, ADR-007): rows from `edit.json`, a ruler and a playhead
 * in one native scroll container. Interaction lives in `timelineController.ts` and editing
 * (S7V-034) in `timelineEditor.ts`, outside React; this component renders their snapshots.
 */
import type { EditDocument, MediaAsset, ScopedProjectRef } from "@t3tools/contracts";
import { startTransition, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import type { PlayerFramePlan } from "../../../editor/editPlayback";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { formatTimecode, framesPerSecondRounded } from "./mediaTime";
import { createTimelineController } from "./timelineController";
import { createTimelineEditor, type TimelineEditActions } from "./timelineEditor";
import { timelineModelOf } from "./timelineModel";
import { TimelineViewContext } from "./timelineView";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineTrack } from "./TimelineTrack";
import {
  TIMELINE_RULER_HEIGHT_PX,
  TIMELINE_TRACK_COLOR,
  TIMELINE_TRACK_GAP_PX,
  TIMELINE_TRACK_HEIGHTS_PX,
  TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX as LABELS_PX,
} from "./vendor/opencut/theme";

const SKELETON_ROWS = 5;

/** What the timeline needs to edit: the revision it shows, and the edit RPCs (S7V-034). */
export interface TimelineEditing {
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly actions: TimelineEditActions;
}

export function TimelineSkeleton() {
  return (
    <div role="status" aria-label="Loading the timeline" className="flex flex-col gap-1 p-2">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="h-6 rounded-sm bg-muted/50" />
      ))}
    </div>
  );
}

export function Timeline(props: {
  readonly projectKey: string;
  readonly document: EditDocument;
  /** False while the player previews a single clip from Assets. */
  readonly playheadVisible: boolean;
  /** The frame the playhead starts on (where the player last was). */
  readonly initialFrame: number;
  readonly onSeek: (editFrame: number) => void;
  /** What the player plays, for mapping its frames (`editFrames.ts`); null when no edit plays. */
  readonly plan?: PlayerFramePlan | null;
  /** The project and its media library, for each clip's media slot (S7V-035). */
  readonly projectRef?: ScopedProjectRef;
  readonly mediaById?: ReadonlyMap<string, MediaAsset>;
  /** Absent: the timeline is read only. */
  readonly editing?: TimelineEditing | undefined;
}) {
  const model = timelineModelOf(props.document);
  const { fps } = model;
  const lanesHeight = model.rows.reduce(
    (total, row) => total + TIMELINE_TRACK_HEIGHTS_PX[row.kind] + TIMELINE_TRACK_GAP_PX,
    TIMELINE_TRACK_GAP_PX,
  );
  const totalHeight = TIMELINE_RULER_HEIGHT_PX + lanesHeight;

  const [controller] = useState(() =>
    createTimelineController({
      projectKey: props.projectKey,
      durationFrames: model.durationFrames,
      framesPerSecond: framesPerSecondRounded(fps),
      initialFrame: props.initialFrame,
    }),
  );
  const { subscribe, getSnapshot, attachScroller, attachContent, attachPlayhead, attachSlider } =
    controller;
  const [editor] = useState(() =>
    createTimelineEditor({
      pxPerFrame: () => controller.getView().pxPerFrame,
      playheadFrame: controller.playheadFrame,
      focus: controller.focus,
    }),
  );
  const { attachLanes, attachPreview, attachAnnouncer } = editor;
  const editorState = useSyncExternalStore(editor.subscribe, editor.getState);
  const editing = props.editing;
  const revision = editing?.revision ?? -1;
  const rows = model.rows;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the editor (outside React) which rows and revision are on screen, before any pointer event can use them
  useLayoutEffect(() => {
    editor.setModel(rows, revision, fps);
  });
  const actions = editing?.actions ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the editor (outside React) the edit RPCs and the controller's key path
  useEffect(() => {
    editor.setActions(actions);
    controller.setKeyHandler(actions === null ? null : editor.onKeyDown);
  }, [editor, controller, actions]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the editor's timers and document listeners on unmount
  useEffect(() => () => editor.destroy(), [editor]);
  const [snapshot, setSnapshot] = useState(getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the controller's snapshot; scroll and zoom steps render as transitions, so React never blocks a frame while CSS already shows the new geometry
  useLayoutEffect(() => {
    return subscribe((urgent) => {
      if (urgent) setSnapshot(getSnapshot());
      else startTransition(() => setSnapshot(getSnapshot()));
    });
  }, [subscribe, getSnapshot]);
  const onSeek = useStableCallback(props.onSeek);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the controller (outside React) the edit's length before paint, and lets it size spans React just mounted
  useLayoutEffect(() => {
    controller.setDuration(model.durationFrames);
    controller.setContentHeight(totalHeight);
    controller.sizeSpans();
  });
  const plan = props.plan ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives the playhead driver (outside React) the player's plan for mapping its frames
  useEffect(() => {
    controller.setPlan(plan);
  }, [controller, plan]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the controller's DOM listeners the seek path and timecode format
  useEffect(() => {
    controller.setSeekHandler(onSeek);
    controller.setFrameFormatter((frame) => formatTimecode(frame, fps));
  }, [controller, onSeek, fps]);
  const { playheadVisible, initialFrame } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows or hides the playhead element, which the controller moves outside React
  useEffect(() => {
    controller.setPlayheadVisible(playheadVisible, initialFrame);
  }, [controller, playheadVisible, initialFrame]);

  const visible = snapshot.window;
  const toolbar =
    editing === undefined ? null : (
      <TimelineToolbar
        hasSelection={editorState.selected.size > 0}
        canUndo={editing.canUndo}
        canRedo={editing.canRedo}
        onSplit={editor.split}
        onDelete={editor.deleteSelection}
        onUndo={editor.undo}
        onRedo={editor.redo}
      />
    );
  const announcer = (
    <div ref={attachAnnouncer} role="status" aria-live="polite" className="sr-only" />
  );

  if (model.itemCount === 0) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        {announcer}
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Your edit will appear here
        </div>
      </div>
    );
  }

  return (
    <TimelineViewContext value={controller}>
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        {announcer}
        <div
          ref={attachScroller}
          role="group"
          aria-label="Timeline tracks"
          tabIndex={-1}
          data-testid="timeline-scroller"
          data-px-per-frame={snapshot.pxPerFrame}
          className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-background outline-none select-none [contain:strict]"
        >
          <div
            ref={attachContent}
            className="relative overflow-clip"
            style={{ height: totalHeight }}
          >
            <div className="sticky top-0 z-20 flex bg-background">
              <div
                className="sticky left-0 z-30 shrink-0 border-r border-b bg-background"
                style={{ width: LABELS_PX, height: TIMELINE_RULER_HEIGHT_PX }}
              />
              <TimelineRuler
                fps={fps}
                pxPerFrame={snapshot.pxPerFrame}
                window={visible}
                durationFrames={model.durationFrames}
                attachSlider={attachSlider}
              />
            </div>
            <div className="flex">
              <div
                className="sticky left-0 z-30 flex shrink-0 flex-col border-r bg-background"
                style={{
                  width: LABELS_PX,
                  gap: TIMELINE_TRACK_GAP_PX,
                  paddingTop: TIMELINE_TRACK_GAP_PX,
                }}
              >
                {model.rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-1.5 truncate px-2 text-xs text-muted-foreground"
                    style={{ height: TIMELINE_TRACK_HEIGHTS_PX[row.kind] }}
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-xs"
                      style={{ background: TIMELINE_TRACK_COLOR[row.kind] }}
                    />
                    <span className="truncate">{row.label}</span>
                  </div>
                ))}
              </div>
              <div
                ref={attachLanes}
                data-testid="timeline-lanes"
                className="relative flex flex-1 flex-col"
                style={{
                  gap: TIMELINE_TRACK_GAP_PX,
                  paddingTop: TIMELINE_TRACK_GAP_PX,
                }}
              >
                <div
                  ref={attachPreview}
                  aria-hidden
                  data-testid="timeline-preview"
                  className="pointer-events-none absolute inset-0 z-20"
                />
                {model.rows.map((row) => (
                  <TimelineTrack
                    key={row.id}
                    row={row}
                    fps={fps}
                    pxPerFrame={snapshot.pxPerFrame}
                    detailScale={snapshot.detailScale}
                    window={visible}
                    durationFrames={model.durationFrames}
                    environmentId={props.projectRef?.environmentId}
                    projectId={props.projectRef?.projectId}
                    mediaById={props.mediaById}
                    highlighted={editorState.highlighted}
                  />
                ))}
              </div>
            </div>
            <div
              ref={attachPlayhead}
              aria-hidden
              data-testid="timeline-playhead"
              className="pointer-events-none absolute top-0 z-25 w-0.5 bg-foreground will-change-transform"
              style={{ left: LABELS_PX - 1, height: totalHeight }}
            />
          </div>
        </div>
      </div>
    </TimelineViewContext>
  );
}
