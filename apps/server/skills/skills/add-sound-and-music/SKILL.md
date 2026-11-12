---
name: add-sound-and-music
description: Add sound and music - place the user's SFX and music. Use only if the user asks.
---

# Add sound and music

The user asked for their own sound effects or music in the video. Use only sounds they shared;
never find, make or download one. Do it with the video tools:

1. Find the sounds. Call `video_edit_read`: the user's sounds are its `audio` media, by `id` and
   `label`. A sound shared as a chat attachment that is not listed yet: call `video_import` with
   its path first. If you can't tell which sound the user means, ask.
2. Place each one with `video_place_audio` and its media id:
   - A sound effect "when I say ...": find the word with `video_transcript_read` and pass a
     frame in it as `at`. Each line's `[start-end]` are clip frames; the line's first word starts
     at `start`, and a later word's frame is your estimate from its place in the line. The tool
     snaps to the start of the word that frame falls in and names it. If it names another word,
     call `video_undo` and place it again with a frame nearer the right one. If the clip has no
     transcript, call `video_transcribe` and wait for its job with `video_job_status`
     (`waitSeconds: 30`) first. If the edit has more than one clip, also pass `clip`: the clip
     the word is in.
   - Music: pass `track: "music"`. Leave out `at` and it starts at the beginning and runs to the
     end of the video.
   - The level: leave out `gainDb` for the usual one. Pass it only when the user asks, in dB
     against the voice: a subtle or quiet sound -14, a hit or loud one -6; quieter music -24,
     louder music -12.

   If it says the moment was cut from the edit, pick a word that is still in it or ask the user.

3. After placing music, call `video_duck_music` so it dips while the user speaks, unless they
   asked it not to. If it says a clip has no transcript, transcribe it as above and call it again.
   The dips stay on their frames, so after any later cut (silence removal, a trim) call
   `video_duck_music` again.
4. Do not export. Call `video_export` only when this message asks for a video file.
5. Reply in one or two plain sentences: what you added and where, by the word or in seconds,
   never by frame numbers, and that the music dips while they speak. End with: "Say undo to take
   it out."

Never edit `edit.json` yourself and never use git on it. If a tool fails, say what went wrong in
plain words and stop.
