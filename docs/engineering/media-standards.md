<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Media standards

What "correct" means for anything s7video imports, previews or renders. Reviewers apply this page to
every ticket marked `Touches media: yes`, and golden media tests ([testing.md](testing.md)) check it.

## Time and frame accuracy

- The project timeline has one constant frame rate (default 30 fps, also 24, 25, 29.97, 50, 59.94
  and 60). All edit positions are stored as rational time or frame numbers in that rate, never as
  floating-point seconds.
- Cuts land on frame boundaries: an in point or out point the agent or user picks renders as exactly
  that frame, with no extra or missing frame at the join.
- Sources with a variable frame rate (most phone footage) are mapped through their real presentation
  timestamps, not an assumed average rate.
- Proxies keep the source's timestamps, so a frame chosen on a proxy is the same frame in the
  original.
- 29.97 and 59.94 fps use drop-frame-aware timecode in anything shown to the user.

## Audio and video sync

- After any cut, speed change, concatenation or render, the audio-to-video offset is at most one
  video frame at the project rate (33 ms at 30 fps), and never has audio leading by more than 20 ms.
- There is no drift: the offset at the end of a render equals the offset at the start within 1 ms per
  minute of output.
- Audio is resampled to the project rate (default 48 kHz) once, at import or render, not repeatedly.
- Cuts in speech get short fades (a few milliseconds) so they do not click; the fade does not move
  the cut point.

## Loudness

- Loudness is measured to ITU-R BS.1770-4 / EBU R128 (integrated LUFS, true peak in dBTP).
- Default export target: −14 LUFS integrated, ±1 LU, true peak at or below −1.0 dBTP. A style pack or
  the user may choose another target; the render meets whatever target is set.
- Music and sound effects duck under speech; speech intelligibility wins over music level.
- Silent clips stay silent: normalisation never amplifies noise from a clip with no real audio.

## Colour

- Default deliverable: SDR Rec. 709 (BT.709 primaries, transfer and matrix), limited (TV) range for
  H.264 and HEVC.
- Renders always write explicit colour tags. A source with missing tags is treated as Rec. 709 and the
  assumption is logged.
- HDR sources (HLG or PQ, common from iPhones) are tone-mapped to SDR for an SDR export, never just
  re-tagged. HDR export keeps HDR tags and metadata.
- Overlays and captions use the same colour space as the video, so a brand colour looks the same in
  preview and export.
- Preview and export match: what the player shows for a frame is what the render produces, apart from
  proxy resolution.

## Captions and layout

- Caption word timings come from the word-timed transcript; each word appears within one frame of
  when it is spoken.
- Safe zones are respected per aspect ratio (9:16, 1:1, 16:9), including the areas platforms cover
  with their own buttons and text on vertical video.
- Fonts used in captions are bundled with their licence (OFL or similar) or come from the user's
  system; a missing font falls back visibly, never silently to a different style.

## Encoding

- Use Apple's hardware encoders (`h264_videotoolbox`, `hevc_videotoolbox`); s7video does not ship
  software H.264 or HEVC encoders.
- FFmpeg is the LGPL build (`--disable-gpl --disable-nonfree`), dynamically linked.
- Default export: H.264 High profile, AAC-LC 48 kHz stereo, MP4 with `faststart`, at the source or
  chosen resolution (1080x1920 for vertical by default).
- Originals are never re-encoded in place or modified; every render reads from the originals, not
  from proxies.

## Measuring

Golden tests and reviewers measure with the bundled FFmpeg: `ebur128` (loudness and true peak),
`ssim` (picture), `ffprobe` (frame count, timestamps, colour tags, sample rate). Record the command
and its output in the PR when a media change is reviewed by hand.
