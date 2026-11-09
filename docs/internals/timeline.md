<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Timeline

The Editor panel's timeline (S7V-033, ADR-007): `apps/web/src/components/editor/timeline/`. It
reads `edit.json` through `useProjectEdit` and changes it only through `edit.apply`, `edit.undo`
and `edit.redo` (S7V-034). The rules below are what kept it at 0 dropped frames with 1,000 clips;
editing and the player clock (S7V-039, [player-clock.md](player-clock.md)) build on them.

## The controller owns geometry, React owns the mounted set

`timelineController.ts` holds the zoom (px per frame), the scroll listeners and the playhead. It
writes the content width and the width of every `data-timeline-span` element (the ruler and each
track row) itself. Clips, ruler ticks and canvas strips are **percentages of that span**
(`laneGeometry.ts`), so a zoom step changes a few widths and the browser only re-lays out.

- Do not set those widths, or any pixel position that depends on the zoom, from React. A React
  commit can land a few frames after the zoom it was rendered for, and would undo it.
- Do not position clips with an inherited CSS variable (`calc(var(--ppf) …)`). Changing a variable
  on an ancestor restyles every descendant: at 4× CPU throttle that cost 15–20 dropped frames per
  zoom sweep, against 0–1 with span percentages.
- Scroll bucket crossings and zoom steps reach React as transitions (`subscribe(urgent)`), and a
  zoom gesture re-renders only when the mounted window stops covering the screen or the ruler's
  spacing drifts by more than the band in the controller. Only resize, edit length and mount are
  urgent.
- No layout reads on the wheel, zoom or playback paths: a read after a commit forces a restyle
  inside the event. The controller keeps the scroll offsets from the `scroll` event (the one place
  it reads them), the scroller's rect and height from resize callbacks and pointer down, and the
  rows' height from React (`setContentHeight`).
- A plain vertical wheel scrolls the edit sideways, as in CapCut. When the rows are taller than
  the timeline (more than one track of a kind) it scrolls them first and goes sideways once they
  reach their edge. The pane's minimum and default heights fit the ruler, five rows and a classic
  scrollbar, and a stored height re-clamps when the panel shrinks.

## Frames

Positions are integer frames at the document fps, at the item `start`s in `edit.json`. Both
players publish those frames ([player-clock.md](player-clock.md)): the multi-clip clock by
construction, and the Engine A player because it only gets edits whose packed frames equal the
starts. `editFrames.ts` is therefore the identity; a click past the edit's end moves only the
timeline's playhead.

## Waveforms and filmstrips (S7V-035)

- **Where:** `ClipMediaSlot.tsx`. `TimelineClip` renders it inside every block that shows project
  media, with `environmentId`, `projectId`, the `TimelineItem` (`start`, `duration`, `in`,
  `mediaId`), the track kind, the edit fps, the block height and the media library's
  `MediaAsset`. It renders `ClipMediaTilesLive` once `asset.mediaData` has that part `ready`. Video
  clips show the filmstrip edge to edge and their sound along the bottom 40 %; SFX and music clips
  show only the waveform; text items get no slot.
- **Pixel span:** the visible width and frame range change on every scroll and zoom step, so they
  never come from React props. The slot reads `TimelineViewContext` (`getView()`, and
  `subscribeView(listener)`, coalesced to one update per animation frame) and
  `clipSpanInView(item, view)` outside React. Only slots with ready media data subscribe. The slot moves its layer and posts each
  view to `ClipMediaTilesLive` directly, so a scroll or zoom step re-renders no clip; canvases
  mount the first time their clip is on screen, not for every clip in the overscan. The worker
  gets source frames at the edit's fps, with the item's `in` as `anchorFrame`
  ([media-data.md](media-data.md)).
- **Cost:** a full zoom sweep of a 30-minute edit with 120 media canvases runs no main-thread task
  over 50 ms and drops no frame, but React's clip window trails the view on 2 to 6 of about 520
  frames, against 0 to 2 with no media data (same sweep, same machine). Posting fewer views or
  redrawing at 30 Hz did not change it, but stopping the worker's draws did, so the cost follows
  the number of worker canvases presented per frame. One canvas per row instead of per clip is
  the next step if it ever shows.
- **Colour:** the waveform takes the track colour the layer inherits. Each canvas reads it once,
  not per view (that forced a style pass every frame), and again when the root element's class,
  style or theme id changes, so a light or dark switch redraws in the new colour.
- **Stacking:** the layer has a negative `z-index` inside the block (its `contain: strict` makes it a
  stacking context), so it paints over the block's fill and under its label.
- **Placeholders:** the block's flat fill shows until `ClipMediaTiles` draws; the timeline never
  waits for media data.
- `ClipMediaSlot.browser.test.tsx` checks the seam's props with a stand-in;
  `ClipMediaSlot.tiles.browser.test.tsx` draws real tiles from synthetic media data and is S7V-035's
  AC-7 check (no main-thread task over 50 ms while scrolling and zooming a 30-minute edit).

## Editing (S7V-034)

`timelineEditor.ts` holds selection, the ported OpenCut controllers (`controllers/`) and the keys,
outside React like the controller. What the code does not show:

- **One gesture, one batch.** A drag or trim previews in a ghost layer (`dragPreview.ts`) and sends
  nothing until release. The release is a delta, planned again against the rows on screen when it
  is sent (`timelineEdits.ts`), so one `edit.apply`, one history step. A burst of arrow nudges on
  the same selection becomes one move after `NUDGE_SETTLE_MS`.
- **Revisions.** A batch goes with the revision the timeline shows. While the timeline's own
  request is in flight, the next gesture waits for its reply and its new revision, so it never
  sends a stale base. Any other change of revision (the assistant, an outside edit) cancels an open
  gesture with a notice; a stale base that still reaches the server comes back as `EditConflict`.
- **Versions (S7V-069).** Each batch is one version by "You", worded by `describeOps.ts`: one line
  per kind of change, counted when it touches several items ("Moved 3 items"). An undo with a
  nudge still pending drops only the nudge and sends nothing.
- **The ghost stays until the edit arrives**, so a moved clip never flashes back to its old place.
- **Linked items.** The server carries items that share a `linkId` (`applyEditOps.ts`), so the
  timeline names one item per link group; naming both would move them twice.
- **No per-clip handles.** Trim handles are drawn on selected clips only; a press within 6 px of
  any clip's edge trims it, and one delegated pointermove sets the resize cursor there. Two handle
  elements on every mounted clip cost a dropped frame in the 1,000-clip scroll test. Clips under
  18 px have no edge zones (handles hidden by a container query), so they can always be moved.
- **Ripple stays on its track.** A ripple delete closes the gap on the deleted item's own track;
  sounds on other tracks do not follow. A transcript caption track is rebuilt in the same change
  instead ([captions.md](captions.md)), and its rows are read-only. `video_assemble`'s mid-edit `at` is the one
  place that moves every track in step.
- A press on a clip selects it and does not seek; a read-only timeline (no `editing`) still seeks.

## Text edits (S7V-038)

The Transcript tab cuts and restores words through the same `edit.apply` (origin `transcript`),
with the rules in `packages/shared/src/editWordCuts.ts`, which silence removal also uses.

- **A cut is split + ripple delete** on the items under it, never `setKeepRanges`, which re-lays the
  clip end to end and would undo manual moves and gaps. All splits come first in the batch, so
  every frame is planned from the document the tab rendered. Split parts are named `vt…`, a prefix
  the server never allocates.
- **`restoreRange` keeps the layout** (PO 2026-11-06): each missing part joins the item that plays
  its source neighbour and pushes later items on that track right. It no longer re-lays in source
  order; `setKeepRanges` still does.
- **Restore is the inverse of a cut** when the gaps were not cut before: toward a kept word the
  whole gap comes back. After a silence cut, restoring a word also brings back the pauses beside
  it; the tab says so, and Undo gives the exact earlier edit.
- **Sound on its own track is refused.** When the clip's sound sits on another track, linked or
  not (`hasLinkedAudio`, shared with silence removal), cutting or restoring only the video would
  put the sound out of step, so the tab says words can't be cut there yet.
- **What plays comes from the edit.** The struck marks follow the part on screen; a reused clip can
  play a struck word elsewhere, so Cut or Restore is chosen from the edit's items.
- **One click still seeks.** Selecting needs a drag or shift-click (or shift + arrows). The
  selection is set by attribute outside React, like the highlight, so a drag re-renders nothing.

## Performance test

`Timeline.perf.browser.test.tsx` is spike B1's harness: a generated 1,000-clip edit, a real CDP
scroll gesture and ctrl + wheel zoom sweeps, frames timed with `requestAnimationFrame`. It runs
React's development build, which is slower than the app's, so its 4× throttle pass is pessimistic;
it asserts the unthrottled numbers and that the mounted clips cover the screen on every frame,
and logs the 4× numbers. `VITE_TIMELINE_PERF_THROTTLED=1` also asserts them loosely (at most 3
dropped frames per run); run that on a quiet machine, since throttled timings swing with other
load. CPU throttling slows script, style and layout but not the GPU or a 60 Hz panel, so it is a
regression guard, not the M1 Air check. `--silent=false` prints every number.
