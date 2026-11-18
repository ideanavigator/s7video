<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Punch-in zoom

A punch-in (S7V-037, the `video_zoom` tool and `punch-in-zoom` skill) is a `zoom` on the video
items it covers in `edit.json`: `{ scale, anchorX, anchorY, rampFrames }`. The export draws it;
the player doesn't yet (S7V-092).

## Writing it

- **The range is clip frames**, as `video_transcript_read` shows them, mapped through the first
  video track with the captions' runs and rounding (`timelineRangesOf` in `timelineMap.ts`, the
  range twin of S7V-036's `timelineFrameOf`). A frame that plays twice zooms where it first plays.
  With several clips, `clip` names the one the range is in, or the tool refuses ("say which clip").
- **One change:** `zoomOps` splits each item the range covers in part with the timeline's own
  `splitItem` (`vz` ids, right to left, so an item keeps its id on its left part), then sets the
  zoom on each covered part. A split continues its source, so the caption runs and the captions
  don't change; the rebuild adds nothing.
- **Later cuts keep it.** Silence removal re-lays a clip in source order with `setKeepRanges`;
  `layRanges` cuts each kept range where the old items' zoom changes, and each part takes the zoom
  of the item it lies in (PO, 2026-11-12). Text cuts and timeline splits use `splitItem`, whose
  right part keeps the zoom.

## Drawing it

- **After the canvas crop**, so the anchor is a point of the frame the viewer sees. Captions burn
  in on the joined video after every segment's zoom, so they never zoom.
- **The anchor is the zoom's fixed point:** the pixel at (`anchorX`, `anchorY`) stays where it is
  while the picture grows around it, as CSS `transform-origin` does. The default is the middle of
  the upper third, about a framed face's eyes (PO, 2026-11-08), so the eyes stay put. It never
  needs clamping; `zoom.py` clamps anyway after rounding.
- **Whole, even pixels:** the frame is scaled to `2·round(W·s/2)` × `2·round(H·s/2)` and the
  canvas is cut out at `2·round(a·(S−W)/2)`, for 4:2:0 chroma.
- **Golden `zoom-crop-presets` compares each zoomed frame with the source frame** put through the
  export's own canvas chain and the same rectangle, never encoded (SSIM ≥ 0.98, and above the
  rectangle 2 px off). Not with the unzoomed export's decoded frame zoomed: that stacks one
  export's compression loss, magnified by the upscale, on the other's, and measured 0.976–0.981
  on `talking-head-01`, where the zoomed export keeps its source as well as the unzoomed one
  (0.983–0.986 against 0.982–0.984; coordinator decision, 2026-11-12).
- **A ramp is per item:** with `rampFrames` N the scale grows linearly from 1 on the item's first
  frame to the target on frame N. Each ramp frame gets its own still zoom (`zoom.ramp_parts`), and
  the parts are split, trimmed and joined again inside the item's segment, so its sound and its
  joins are any segment's. **Not `scale` with `eval=frame`:** FFmpeg's `scale` can change the size
  per frame, but `crop` keeps placing its rectangle by the first frame's size, so a moving size is
  cut out at the wrong place (S7V-037 Check 2). Each item restarts its ramp, so a ramp that a cut
  or split divides starts again on the second part. The tool always writes 0, a hard punch-in.

## In the player (S7V-092)

`transform: scale(s)` with `transform-origin: anchorX anchorY` on the video, inside the canvas's
clip, gives the export's picture up to the even rounding.
