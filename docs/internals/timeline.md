<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Timeline

The Editor panel's timeline (S7V-033, ADR-007): `apps/web/src/components/editor/timeline/`. It
reads `edit.json` through `useProjectEdit` and never writes it. The rules below are what kept it at
0 dropped frames with 1,000 clips; editing (S7V-034) and the player clock (S7V-039) build on them.

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

Positions are integer frames at the document fps. The player publishes packed frames (kept-frame
counts); `editFrames.ts` converts them with the player's plan. Today that is the identity, which
holds for every edit Engine A makes; a frame the plan does not play (a later clip in a "Plays X
only" edit) has no player frame, so a click there moves only the timeline's playhead. S7V-034
and S7V-039 change the mapping there only.

## Waveforms and filmstrips (S7V-035)

This card merges first and leaves the seam; S7V-035 wires `ClipMediaTiles` into it.

- **Where:** `ClipMediaSlot.tsx`. `TimelineClip` renders it inside every block that shows project
  media, with `environmentId`, `projectId`, the `TimelineItem` (`start`, `duration`, `in`,
  `mediaId`), the track kind, the edit fps, the block height and the media library's
  `MediaAsset`. S7V-035 reads `asset.mediaData` and renders `ClipMediaTiles` in place of the
  `null`.
- **Pixel span:** `ClipMediaTiles` needs the visible width and frame range, which change on every
  scroll and zoom step. Do not pass them from React (see above). Read them from
  `TimelineViewContext`: `getView()` and `subscribeView(listener)` give the frames on screen and
  the px per frame now, synchronously from the scroll or zoom, and `clipSpanInView(item, view)`
  turns that into the clip's visible part in edit frames, source frames (`in` added) and pixels.
  A slot holds the span in state it updates from the subscription, so only clips with media
  data re-render, and it may coalesce updates to one per animation frame. Position the canvas
  at `offsetPx` inside the block, with the worker given the source frames.
- **Placeholders:** the block's flat fill shows until `ClipMediaTiles` draws; the timeline never
  waits for media data.
- `ClipMediaSlot.browser.test.tsx` mounts a stand-in in the slot and checks the props and the
  view, as S7V-035 will use them.

## Performance test

`Timeline.perf.browser.test.tsx` is spike B1's harness: a generated 1,000-clip edit, a real CDP
scroll gesture and ctrl + wheel zoom sweeps, frames timed with `requestAnimationFrame`. It runs
React's development build, which is slower than the app's, so its 4× throttle pass is pessimistic;
it asserts the unthrottled numbers and that the mounted clips cover the screen on every frame,
and the 4× numbers loosely (at most 3 dropped frames per run). CPU throttling slows script, style
and layout but not the GPU or a 60 Hz panel, so it is a regression guard, not the M1 Air check;
`--silent=false` prints every number.
