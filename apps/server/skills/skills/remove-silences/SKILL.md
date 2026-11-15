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
   after ..."), check before you undo: an undo takes out the newest change, which may not be the
   cut. A version holds every change from one reply, so call `video_versions`, then `video_versions` with the newest
   version (`version: "vN"`) to read its `Changes:` list. An "Undid the last change" cancels the
   change just before it and a "Redid a change" brings it back, so an undone change is not one to
   put back. If a list ends in "…and more changes", or a later version is "Restored from vN",
   you can't see every change since the cut. Name the ones you can see, say there were more, and
   offer a safe choice, for example: "I can see the zoom and the music since the cut, and there
   were more changes I can't list. Should I cut more loosely and redo just those two, or leave
   the cut as it is?"
   - If the cut is the last change, or only the `video_duck_music` you ran for it follows it,
     call `video_undo` once for each of those (once, or twice with the re-duck), then
     `video_remove_silences` with the new setting. Do not ask.
   - Otherwise read the `Changes:` of the version with the cut too. Every change in it other
     than the cut and its re-duck, and every change in later versions, must come back. Name them
     in editing words and ask, for example: "To cut less tightly I'll go back to before the cut,
     cut again more loosely, then put back the reel shape and the zoom at 0:08. OK?" If the user
     agrees, call `video_version_restore` with the version before the one with the cut, then
     `video_remove_silences` with the new setting, then redo each change you named, and say
     which ones you put back.

   If its result says to run `video_duck_music` again, do it, so the music dips under the new
   speech.

   If it says the sound is still being measured, call `video_job_status` with that `jobId` and
   `waitSeconds: 30` until the job ends. If it `succeeded`, call `video_remove_silences` again;
   if it `failed` or was `cancelled`, tell the user and stop.

3. Do not export. If the user also asked for captions, call `video_add_captions` after the cut.
   Call `video_export` only when this message asks for a video file ("export", "render", "make
   the video"), never because an earlier message did. Call `video_canvas` only when the user names a
   shape (reel or tall 9:16, wide 16:9, square 1:1, 4:5, 4:3); otherwise the video keeps the clip's
   own shape.

4. Reply in one or two plain sentences: how many seconds you removed and how many cuts you made,
   taken from the tool's result, and say the music dips were fitted to the new cut if you ran
   `video_duck_music`. If the result says a pause you asked to keep was cut by an
   earlier edit, tell the user it stays cut and offer to undo back to before that cut, then ask
   again. Describe a pause by the word next to it or in seconds, never by frame numbers. When
   the result says `changed: true`, end with: "Say undo to put it back." When nothing new was
   cut (`changed: false`), say the edit is unchanged and do not offer that undo.

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
