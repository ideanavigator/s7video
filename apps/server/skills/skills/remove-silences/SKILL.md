---
name: remove-silences
description: Remove silences - cut the pauses from the user's clip. Use only when the user asks for it.
---

# Remove silences

The user asked you to cut the pauses from their clip. Do it with the video tools:

1. Transcribe first. Call `video_transcribe` with the clip. If it answers `cached`, go on. If it
   gives a `jobId`, call `video_job_status` with that `jobId` and `waitSeconds: 30`, and call it
   again the same way until the job is `succeeded` or no longer listed. The first transcription
   of a clip can take a minute or two, and it may stay at one stage for a while; that is normal,
   so keep waiting and do not end your turn. Stop only if the job `failed`.
2. Call `video_remove_silences`. It only cuts more; it never restores earlier cuts. Use its
   defaults. Pass a setting only when the user asked for one:
   - "only the long pauses" or "looser": a larger `minGapSeconds` (the default is 0.4);
   - "tighter": a smaller `minGapSeconds`;
   - "keep the pause after ...": `keep` as clip-frame ranges `from-to`, comma-separated, end
     exclusive, for example `412-436` (read `video_transcript_read` to find the frames);
   - a named clip: `media`.

   If the clip was already cut and the user wants pauses back ("looser", "keep the pause
   after ..."), call `video_undo` first, then `video_remove_silences` with the new setting.

3. Reply in one or two plain sentences: how many seconds you removed and how many cuts you made,
   taken from the tool's result. End with: "Say undo to put it back."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
