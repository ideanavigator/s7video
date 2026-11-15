---
name: caption-style
description: Caption style - set the look of the user's captions. Use only if the user asks.
---

# Caption style

The user asked how their captions look. There are four looks, all ours:

- `s7-neutral`, "Plain": white bold text with a hard shadow, the usual look;
- `s7-box`, "Boxed": white text on a dark box;
- `s7-karaoke`, "Highlighted word": the word being said lights up;
- `s7-minimal`, "Minimal": smaller text with a thin outline.

On top of any look, `custom` changes only these, and keeps the ones not given:

- `textColor`, `highlightColor` (only in Highlighted word: the lit word), `boxColor` (only in
  Boxed: the box): hex colours. Turn the user's words into one: orange `#FF8800`, red `#FF3B30`, yellow
  `#FFD60A`, green `#34C759`, blue `#0A84FF`, pink `#FF2D92`, purple `#AF52DE`, black `#000000`,
  white `#FFFFFF`;
- `size`: 0.6 to 1.6, where 1 is the look's own size; "a bit bigger" is about 0.2 more than now;
- `position`: `top`, `middle` or `bottom`.

1. If the user did not say which look or what they want, call `video_caption_style` with no
   `preset` and no `custom`; follow step 2 of the add-captions skill to show the looks and ask.
2. Otherwise make one `video_caption_style` call for the whole request: `preset` for a look
   ("boxed"), `custom` for colours, size or place ("orange words, near the top"), or both. Leave
   `preset` out to keep the current look. If the edit has no captions yet, the call adds them.
3. If the user asks for anything else (a font, an animation, another app's style), make no call:
   say in one plain sentence what can change (the four looks, colours, size, top, middle or
   bottom) and ask. Never make a style up.
4. If it says a clip has no transcript, call `video_transcribe` with that clip and wait for its
   job with `video_job_status` (`waitSeconds: 30`), then call `video_caption_style` again. If it
   says a clip already shows captions in its picture, ask the user the question it gives and stop;
   then do what it said for their answer (`confirm: true`, with the other `position` if they
   chose it). A change to captions the edit already has never asks: if the reply says a clip
   keeps its own captions, pass that sentence on, and on "caption that clip too" call again with
   `confirm: true`.
5. Do not export. Call `video_export` only when this message asks for a video file.
6. Reply in one plain sentence saying the look in the tool's words (colour names, never codes or
   size numbers): it shows over the player and in the export. End with: "Say undo to go back."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
