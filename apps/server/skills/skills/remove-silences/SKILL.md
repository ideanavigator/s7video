---
name: remove-silences
description: Remove silences - cut the pauses from the user's clip. Use only when the user asks for it.
---

# Remove silences

The user asked you to cut the pauses from their clip. Do it with the video tools:

1. Transcribe first. Call `video_transcribe` with the clip. If it answers `cached`, go on. If it
   gives a `jobId`, call `video_job_status` with that `jobId` and `waitSeconds: 30`, and call it
   again the same way while the job's `state` is `running`. The first transcription of a clip
   can take a minute or two, and it may stay at one stage for a while; that is normal, so keep
   waiting and do not end your turn. Then:
   - `succeeded`: go on.
   - `failed`: tell the user the job's `message` in plain words and stop.
   - `cancelled`: the transcription was stopped. Tell the user and stop. Never start a
     transcription the user cancelled again.
   - the job is not listed: tell the user the transcription did not finish and stop.
2. Call `video_remove_silences`. It places the clip on a track itself, so an empty timeline
   is fine; never tell the user the clip must be on a track first. It only cuts more; it never
   restores earlier cuts. Use its defaults. Pass a setting only when the user asked for one:
   - "only the long pauses" or "looser": a larger `minGapSeconds` (the default is 0.4);
   - "tighter": a smaller `minGapSeconds`;
   - "keep the pause after ...": `keep` as clip-frame ranges `from-to`, comma-separated, end
     exclusive, for example `412-436` (read `video_transcript_read` to find the frames);
   - a named clip: `media`.

   If the clip was already cut and the user wants pauses back ("looser", "keep the pause
   after ..."), call `video_undo` first, then `video_remove_silences` with the new setting.

3. Do not export. Captions are added when the user exports; if they asked for captions, say so.
   Call `video_export` only when this message asks for a video file ("export", "render", "make
   the video"), never because an earlier message did. Call `video_canvas` only when the user names a
   shape (reel or tall 9:16, wide 16:9, square 1:1, 4:5, 4:3); otherwise the video keeps the clip's
   own shape.

4. Reply in one or two plain sentences: how many seconds you removed and how many cuts you made,
   taken from the tool's result. If the result says a pause you asked to keep was cut by an
   earlier edit, tell the user it stays cut and offer to undo back to before that cut, then ask
   again. Describe a pause by the word next to it or in seconds, never by frame numbers. When
   the result says `changed: true`, end with: "Say undo to put it back." When nothing new was
   cut (`changed: false`), say the edit is unchanged and do not offer that undo.

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
