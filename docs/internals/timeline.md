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
- No layout reads in wheel or scroll handlers on the horizontal path: a read after a commit
  forces a restyle inside the event (the scroller rect is cached).

## Frames

Positions are integer frames at the document fps. The player publishes packed frames (kept-frame
counts); `editFrames.ts` converts them. Today that is the identity, which holds for every edit
Engine A makes; S7V-034 and S7V-039 change the mapping there only.

## Performance test

`Timeline.perf.browser.test.tsx` is spike B1's harness: a generated 1,000-clip edit, a real CDP
scroll gesture and ctrl + wheel zoom sweeps, frames timed with `requestAnimationFrame`. It runs
React's development build, which is slower than the app's, so its 4× throttle pass is pessimistic;
it asserts the unthrottled numbers and logs the throttled ones (`--silent=false` shows them).
