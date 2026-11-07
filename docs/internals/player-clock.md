<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Player clock

The Editor player for any timeline layout (S7V-039, ADR-007): several sources, gaps, reordered
clips. `apps/web/src/editor/playerClock.ts` is the clock; `MultiClipPlayer.tsx` wires it to three
`<video>` elements and the controls. The preview must match the export (PO, 2026-11-06), so the
clock plays exactly what `plan_segments` in `export.py` renders.

## Which player plays an edit

`playerViewOf` (`editorView.ts`) builds the timeline plan (`editTimelinePlan`) and asks
`playsAsSingleSource`: one media, laid end to end from frame 0, moving forward through the source,
never muted. Those edits keep Engine A's `EditPlayer` (seek over cuts in one element), because its
packed frames then equal the item starts. Every other layout is `play-timeline` and plays on the
clock. Do not widen Engine A's rule: its frames are kept-frame counts, which stop matching
`edit.json` the moment there is a gap or a reorder.

## Frames

- The clock's position is an integer **edit frame at the item `start`s**, at the document fps.
  Gaps (and items whose source is missing) are black and count frames on the host clock; the
  frame is computed from the gap's start every time, never accumulated, so it does not drift.
- A source frame is `item.in + (editFrame - item.start)` at the document fps, sought by
  `timeOfFrame` (the middle of the frame). Sources at other rates map through their timestamps, as
  export's `fps=` filter does.
- Both players publish edit frames, so `editFrames.ts` is the identity. The timeline playhead,
  the Transcript tab and the player all share `publishPlayerFrame`, `subscribePlayerFrame` and
  `requestPlayerSeek` (`editStore.ts`).

## API (for S7V-034 and later cards)

```ts
const clock = createPlayerClock(plan, host, events);
clock.setSource(mediaId, url | null); // null: missing, failed or resolving; plays as black
clock.setPlan(nextPlan); // an edit changed; equal plans (sameTimelinePlan) are ignored
clock.play();
clock.pause();
clock.seek(editFrame);
clock.frame();
clock.state();
clock.dispose();
```

- `host` gives the element pool, `show(index | null)` (the clock decides which element is
  visible; `null` is black), `now()` on the rVFC clock (`performance.now`), and rAF.
- `events.onFrame` fires every presented frame while playing and once per seek. It is where a
  caller hears the clock; never read an element's `currentTime` for the edit position.
- `events.onStateChange` fires only on changes: `source`, `gap`, `missing` (no URL: the clock runs
  through it as black), `preparing` (the next element was not parked in time; the clock holds).
- `events.onJoin` reports each swap (due time, display time, how long the element was parked).
  The playback golden reads it; production ignores it.
- A playing element is unparked: its parked frame is cleared the moment it plays or carries on
  into the next item, so a replay, a seek while playing or a join after a seek parks it again.
  Trusting an old park skipped a whole clip on replay (review of PR #48).
- `dispose` empties every element's `src` and calls `load()`, so the decoders are freed at once.
- A gesture that edits the timeline (S7V-034) writes `edit.json` and lets the new plan arrive;
  `setPlan` keeps the position (clamped) and keeps playing. Do not drive elements from outside.

## How a join works

- Three elements: the one playing, the next segment's parked paused on its `in` frame, and one
  keeping a recent source loaded. Two would reload a source at nearly every join of an edit that
  alternates three clips, and a reload took up to 450 ms in the spike.
- When the playing element presents its item's last frame, the next item is due one frame time
  later. An rAF loop swaps visibility on the refresh closest to that time and starts the parked
  element. If the playing element presents a frame **past** its item first (rAF ran late), the
  swap happens in that element's rVFC, which runs in the rendering step that would paint the
  frame, so it never reaches the screen. At the edit's end the element pauses on its last frame.
- Two back-to-back items that continue one source are one segment (or carry on without a swap),
  so the element plays straight through.
- Audio follows the visible element; hidden elements are muted and paused. There is no fade at a
  join yet (export fades each segment's audio): routing elements through Web Audio for a
  sample-accurate fade silences cross-origin media and adds output latency to the A/V path, and
  `volume` ramps run at refresh granularity, too coarse for a few-ms fade. A fade needs its own
  ticket and a measurement against AC-3.

## Measured (S7V-039)

- Electron 44 spike (M4 Max, 4K H.264, 1080p HEVC, 1080p H.264 with a 2 s GOP; 12 segments, a gap):
  first frame after each join held at most one extra frame, no skipped frame, every element
  parked at least 470 ms before its join, about 6 % CPU. The slowest supported Mac (M1 Air) was not
  measured.
- Golden `multi-clip-gapless` (headless Chromium, H.264 only: no HEVC decoder there): no join with
  more than one black or frozen frame, no skipped frame, playhead equal to the frame on screen, a
  seek into another source shown in under 50 ms.
- Each join can hold its first frame for up to one extra frame, so a multi-clip preview runs a
  few percent slower than real time at one cut per second. Picture, audio and playhead stay
  together, because all three follow the element.
