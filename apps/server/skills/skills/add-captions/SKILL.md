---
name: add-captions
description: Add captions - put captions in the user's video edit. Use only when the user asks for it.
---

# Add captions

The user asked for captions. They go into the edit, where the user sees them on the timeline and
over the player; they are not a separate video file. Do it with the video tools:

1. Call `video_add_captions`. It captions every clip with sound on the timeline from its
   transcript, and asking again rebuilds the same captions.
2. If it says a clip has no transcript, call `video_transcribe` with that clip. If it gives a
   `jobId`, call `video_job_status` with that `jobId` and `waitSeconds: 30`, and again while the
   job's `state` is `running`; a first transcription can take a minute or two, so keep waiting
   and do not end your turn. When it `succeeded`, call `video_add_captions` again. If it
   `failed` or was `cancelled`, or is not listed, tell the user in plain words and stop.
3. Do not export. Call `video_export` only when this message asks for a video file ("export",
   "render", "make the video"). The export burns in the same captions the player shows.
4. Reply in one plain sentence with how many captions you added, from the tool's result, and
   end with: "Say undo to remove them."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
