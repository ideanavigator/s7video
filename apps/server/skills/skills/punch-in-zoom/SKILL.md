---
name: punch-in-zoom
description: Punch-in zoom - zoom in on a moment of the user's video. Use only if the user asks.
---

# Punch-in zoom

The user asked you to zoom in on a moment ("zoom in when I say ..."). The zoom shows in the
exported video; the player does not show it yet. Do it with the video tools:

1. Find the moment. Call `video_transcript_read` with the clip. Each line's `[start-end]` are clip
   frames; the line's first word starts at `start`, and a later word's frame is your estimate from
   its place in the line. The zoom's `range` is one `from-to` in those frames, end exclusive, for
   example `412-470`: from the start of the moment's first word to the end of its last. If the clip
   has no transcript, call `video_transcribe` and wait for its job with `video_job_status`
   (`waitSeconds: 30`) first.
2. Look at the moment. Call `video_frame` with the clip and a frame inside the range, and find the
   speaker's eyes. `anchorX` and `anchorY` are that point as a share of the frame (0 is left or top,
   1 is right or bottom): the picture grows around it and keeps it where it is. Leave them out when
   the eyes are near the usual place, the middle of the upper third.
3. Call `video_zoom` with `range`, and the anchor when you need it. Leave out `scale` for the usual
   1.25; pass it only when the user asks: a little closer 1.15, much closer 1.5, at most 2. If the
   edit has more than one clip, also pass `clip`: the clip the moment is in. If it says the moment
   was cut from the edit, pick one that is still in it or ask the user.
4. Do not export. Call `video_export` only when this message asks for a video file.
5. Reply in one plain sentence: where you zoomed in, by the words or in seconds, never by frame
   numbers, and that it shows in the exported video. End with: "Say undo to take it out."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
