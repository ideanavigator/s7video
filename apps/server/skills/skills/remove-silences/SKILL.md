---
name: remove-silences
description: Remove silences - cut the pauses from the user's clip. Use only when the user asks for it.
---

# Remove silences

The user asked you to cut the pauses from their clip. Do it with the video tools:

1. Transcribe first. Call `video_transcribe` with the clip. If it answers `cached`, go on. If it
   gives a `jobId`, call `video_job_status` with that id until the job is done.
2. Call `video_remove_silences`. Use its defaults. Pass a setting only when the user asked for one:
   - "only the long pauses" or "looser": a larger `minGapSeconds` (the default is 0.4);
   - "tighter": a smaller `minGapSeconds`;
   - "keep the pause after ...": a `keep` frame range (read `video_transcript_read` to find it);
   - a named clip: `media`.
3. Reply in one or two plain sentences: how many seconds you removed and how many cuts you made,
   taken from the tool's result. End with: "Say undo to put it back."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
