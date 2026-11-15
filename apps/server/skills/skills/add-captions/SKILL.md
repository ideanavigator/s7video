---
name: add-captions
description: Add captions - put captions in the user's video edit. Use only when the user asks for it.
---

# Add captions

The user asked for captions. They go into the edit, where the user sees them on the timeline and
over the player; they are not a separate video file. The user shapes them by talking to you, so
show the looks first unless they already said which one, or described one.

1. If the user named a look or described one ("boxed", "orange words", "at the top"), follow the
   caption-style skill instead: one `video_caption_style` call adds the captions in that look.
2. Otherwise call `video_caption_style` with no `preset` and no `custom`. It changes nothing and
   answers with the four looks, each name with its picture on the next line. Put those lines in
   your reply exactly as they are (keep each `\` line end and each `![…](<…>)` image unchanged),
   then ask in one sentence which look they would like, or what they have in mind. Make no other
   call this turn.
3. If a tool says a clip has no transcript, call `video_transcribe` with that clip. If it gives a
   `jobId`, call `video_job_status` with that `jobId` and `waitSeconds: 30`, and again while the
   job's `state` is `running`; a first transcription can take a minute or two, so keep waiting
   and do not end your turn. When it `succeeded`, call the same tool again. If it `failed` or was
   `cancelled`, or is not listed, tell the user in plain words and stop.
4. If a tool says a clip already shows captions in its picture, ask the user the question it gives
   (for example "This clip already has captions near the bottom. Add new ones at the top, add
   them anyway, or leave it as it is?") and stop. Then do what the tool said for their answer:
   new ones at the other place is `video_caption_style` with `confirm: true` and that `position`
   in `custom`; anyway is the same call with `confirm: true`; leaving it changes nothing. Once
   they said yes, keep `confirm: true` on every caption call in this conversation.
5. When the user picks a look, call `video_caption_style` with its `preset` (see caption-style).
   If they say any look will do, call `video_add_captions`: it captions every clip with sound in
   the Plain look, and asking again rebuilds the same captions.
6. Do not export. Call `video_export` only when this message asks for a video file ("export",
   "render", "make the video"). The export burns in the same captions the player shows.
7. After captions are added, reply in one plain sentence saying so, in the tool's words (never a
   colour code or a number for the size), and end with: "Say undo to remove them."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
