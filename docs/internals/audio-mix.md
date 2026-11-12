<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Sound effects, music and loudness

The user's own sound effects and music go on the `sfx` and `music` tracks of `edit.json` (S7V-036:
the `video_place_audio` and `video_duck_music` tools and the `add-sound-and-music` skill). The
export mixes them under the voice and brings the whole mix to −14 LUFS. Nothing here changes
`edit.json` v1: every field already existed.

## Levels are relative to the voice

- The presets are ours (`apps/server/src/edit/audioLevels.ts`, PO 2026-11-08): sound effects
  "subtle" −14 dB, "normal" −9 dB, "hit" −6 dB, a music bed −18 dB and a −12 dB duck. They are
  starting points the agent may change per item. They are never taken from a client project.
- An item's `gainDb` is relative to its own file, so the tool converts: `voice LUFS + level − file
  LUFS`, to 0.1 dB. The voice is the clip `at` refers to, or the first clip on the timeline.
- Loudness comes from the engine's `media.loudness` (`ebur128`, integrated). The server caches it
  in `.s7cache/loudness/<sha256>.json` and checks the file's fingerprint and size first.
- **Trap:** `ebur128` measures in 400 ms blocks, so a file shorter than one block reads −70 LUFS
  (nothing). `media.loudness` loops files under 3 s to 3 s; a looped sound reads as loud as it is
  while it plays.
- At or below −50 LUFS, the export's quiet line, a file counts as silent, so its noise is never
  lifted. Such a sound is refused. A voice clip that is silent, only room noise, or has no audio
  stream at all (B-roll, a screen recording) levels against −14 LUFS instead. A clip with no audio
  stream is never sent to `media.loudness`, which would refuse it.

## Placement

- `at` is a frame of the clip at its transcript's rate, as `video_transcript_read` shows it. It is
  mapped through the first video track with `captionRuns` and `toRate` from
  `packages/shared/src/captionWords.ts`, the same runs and rounding the captions use (the twin of
  the engine's `map_words`). So a sound on a word lands on that word's caption frame.
- A clip on the timeline more than once plays the frame first where it first plays. With several
  clips, `at` needs `clip` (PO 2026-11-11). Without `at`, the item starts at frame 0 and `clip`
  can be left out.
- `at` then snaps to the start of the clip's word playing there, or else the next word heard,
  and the reply names it (PO 2026-11-12). The reason: `video_transcript_read` stamps lines, not
  words, so the agent can only estimate a word's frame from its place in the line. Word starts
  are the caption's, so a word that crosses a cut starts where its kept part starts. After the
  last word, or with no transcript, `at` is used as given and the reply says it wasn't snapped.
  A frame the edit cut is refused before any snap.
- The edit ends where the video track ends, since that is what the export renders. Sound effects
  play their full length, trimmed there. Music runs there with no loop, fading in over 0.5 s and
  out over 1 s, rounded to whole frames. A bed too short for both fades splits its length between
  them.
- A sound that would overlap another goes on the first free sound effects track, or a new one.
  Locked and muted tracks are skipped. Each placement is one change: one version, one undo step.

## Ducking

- `video_duck_music` writes `duck` on every unlocked music track. The ranges are the clips'
  transcript words on the timeline (`mapCaptionWords`), merged across gaps under 300 ms. Attack is
  150 ms and release 400 ms, in whole frames.
- Locked music tracks are left alone, as placement leaves them. With only locked music, ducking
  refuses in plain words.
- The curve is fixed: per range, down to the depth over the attack before speech starts, held, and
  back up over the release after it ends. Where two curves overlap the deeper one wins. There is no
  compressor and no sidechain, so it never pumps.
- **Limitation:** the ranges are timeline frames, so a later cut leaves them where they were. The
  skill and the tool's reply tell the agent to duck again after a cut. S7V-090 tracks the real fix.

## The export mix

`packages/engine/src/s7engine/mix.py` builds one chain per item. The chain reads the file from `in`
as 48 kHz stereo float (one resample), applies the gain and fades, delays it to its exact first
sample (`sample_at`) and pads it to the edit's length. The voice from the video track and every
chain are summed by `amix=normalize=0`, so nothing is rescaled. The export's three runs are
unchanged. It measures the mix, applies one fixed gain to −14 LUFS with an `alimiter` at
−1.5 dBFS, then checks the result. A mix at or below −50 LUFS gets no gain, so silence stays
silent.

- **Trap: zipper noise.** `volume` with `eval=frame` steps once per audio frame. At FFmpeg's
  default 1,024 samples, a 12 dB duck leaves audible steps (energy 60 dB under a pure tone). A
  ducked chain therefore goes through `asetnsamples=n=64` first, which puts it at the noise floor
  (S7V-036 Check 2).
- The duck envelope is a balanced `if(lt(t,…))` tree of linear pieces. FFmpeg evaluates only the
  branch it takes, so each frame costs log₂ of the piece count, even with hundreds of ranges.
- An item cut short by the end of the video fades out there: over its own fade-out (music's
  1 s), or over 10 ms when it has none (a sound effect), so it never clicks.
- Overlay tracks are still refused.

The golden `mix-sfx-music-lufs` checks it end to end on `talking-head-01` with synthetic sounds:
loudness and true peak, the SFX onset against its word, the duck depth, one constant gain and
A/V sync.

## Not yet

The Editor panel's player plays only the video track's own sound. Sound effects and music are
heard in the export, not yet in the player.
