<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Timeline

The Editor panel's timeline (S7V-033, ADR-007): `apps/web/src/components/editor/timeline/`. It
reads `edit.json` through `useProjectEdit` and never writes it. The rules below are what kept it at
0 dropped frames with 1,000 clips; editing (S7V-034) and the player clock (S7V-039, [player-clock.md](player-clock.md)) build on them.

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

## Performance test

`Timeline.perf.browser.test.tsx` is spike B1's harness: a generated 1,000-clip edit, a real CDP
scroll gesture and ctrl + wheel zoom sweeps, frames timed with `requestAnimationFrame`. It runs
React's development build, which is slower than the app's, so its 4× throttle pass is pessimistic;
it asserts the unthrottled numbers and that the mounted clips cover the screen on every frame,
and logs the 4× numbers. `VITE_TIMELINE_PERF_THROTTLED=1` also asserts them loosely (at most 3
dropped frames per run); run that on a quiet machine, since throttled timings swing with other
load. CPU throttling slows script, style and layout but not the GPU or a 60 Hz panel, so it is a
regression guard, not the M1 Air check. `--silent=false` prints every number.
