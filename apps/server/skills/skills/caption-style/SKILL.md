---
name: caption-style
description: Caption style - set the look of the user's captions. Use only if the user asks.
---

# Caption style

The user asked for a caption look. There are four, all ours:

- `s7-neutral`, "Plain": white bold text with a hard shadow, the usual look;
- `s7-box`, "Boxed": white text on a dark box;
- `s7-karaoke`, "Highlighted word": the word being said lights up;
- `s7-minimal`, "Minimal": smaller text with a thin outline.

1. Pick the one the user means. If they ask for something that is not one of these (a font, a
   colour, another app's style), name the four and ask; never make one up.
2. Call `video_caption_style` with its `preset`. If the edit has no captions yet, it adds them in
   that look. If it says a clip has no transcript, call `video_transcribe` with that clip and wait
   for its job with `video_job_status` (`waitSeconds: 30`), then call `video_caption_style` again.
3. Do not export. Call `video_export` only when this message asks for a video file.
4. Reply in one plain sentence naming the look, from the tool's result: it shows over the player
   and in the export. End with: "Say undo to go back."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
