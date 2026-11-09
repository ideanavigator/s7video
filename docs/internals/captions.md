<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Captions in the edit

"Add captions" (S7V-075, the `video_add_captions` tool and `add-captions` skill) writes a caption
track into `edit.json`. The timeline shows it, the player draws it, and the export burns it in.

## The transcript caption track

- One track, `metadata.s7.source = "transcript"`, label "Captions", id `C1` unless that id is
  taken. Asking again rebuilds it; there is never a second one.
- One caption item per uncut run of the first video track (the track the export renders), with
  its words in timeline frames and its clip in `metadata.s7.media`. The mapping is
  `packages/shared/src/captionWords.ts`, a port of the engine's `map_words`.
  `captionWordsParity.test.ts` checks every word against `captionWordsParity.reference.json`
  (written by Python) everywhere, and against Python itself where uv is installed (on `PATH` or
  `UV`); there it also checks the reference is current. Change one, change the other, then
  `S7VIDEO_GOLDEN_UPDATE=1` rewrites the reference.
- Only clips with sound get captions, the same rule the export uses (`captionMediaOf`). A clip
  with sound and no cached transcript refuses the tool ("Transcribe the clip first"), and nothing
  changes; the agent transcribes and asks again.
- Because items follow runs, the export's `caption_chunks` on the track gives exactly the chunks
  `transcript_chunks` gives without it (golden `caption-track-export`). Old projects with no track
  still export from the transcripts.

## Rebuilt inside every change

`EditDocumentService.apply` rebuilds the track whenever a change alters the first video track's
items: silence removal, transcript cuts and restores, timeline gestures and assembly. The
`setCaptions` is applied to the same draft before validation, under the project lock, so the
edit and its captions share one revision, one version and one undo step. The version line is
worded from the caller's ops only, so a cut still reads "Cut words in the transcript".

- The rebuild reads the transcripts from `.s7cache/transcripts/` directly (`transcriptCache.ts`),
  not through `TranscriptService`, which depends on the edit service.
- A caption track without the mark (hand-written, or from an older tool) is never rebuilt.
- A clip whose transcript can't be read (its drive unplugged, the cache cleared) keeps its caption
  items instead of losing them. `carryCaptions` moves each word through its source frames, as
  the cut moved the clip (a move shifts it; a trim, cut or delete clips or drops it), and drops
  any word that would share a frame with a rebuilt caption, so the track always validates
  (`captionCarry.test.ts`, 200 seeded cuts). The player names the clip ("No transcript for …").
- Undo, redo and "make current" restore whole documents, captions included; they never rebuild.
- Caption rows are read-only on the timeline: a press on one seeks, and split and delete skip
  them (the rows are `locked` in the timeline model).

## The player overlay

The player shows stills drawn by the export's own renderer, so the preview cannot drift from the
export (PO, 2026-11-06). Spike A4 measured HTML text against libass at 0.86 SSIM in the caption
band; the same ASS through the same libass is pixel-equal before scaling.

- With no caption items, the export burns in captions from the clips' transcripts (S7V-046), so
  the player shows those too: the server passes the same transcripts the export would
  (`transcriptMediaFor`), and the engine picks the chunks with the export's own `export_chunks`.
  A track and the fallback on the same edit give the same stills (`test_captions.py`).
- The engine's `captions.render` builds the export's chunks and its ASS (`build_ass`), retimes one
  text per second, and has FFmpeg's `subtitles` filter draw them onto a transparent
  `color=black@0` canvas (`alpha=1`) as RGBA PNGs: about 0.2 s for 54 at 1080×1920 on an M4 Max.
- The engine keeps the stills in `.s7cache/captions/<look>/<text>.png`. `look` hashes the canvas
  size, the style file's bytes, the bundled fonts and `RENDER_VERSION` in `methods/captions.py`;
  `text` hashes the chunk's text. Timing never changes a still, so undo and trims draw nothing,
  and a cut draws only the texts it makes new. **Bump `RENDER_VERSION` when the drawing changes in
  a way those inputs don't show** (the ASS builder's code, the FFmpeg arguments). The newest 4
  looks and 4,000 stills are kept; drawing happens in a `.tmp-*` folder inside the cache, removed
  on any exit, and never counted.
- The stills travel inline (base64) in the `captions.stills` result: one round trip instead of
  one signed URL per still. That is about 28 KB per distinct text at 1080×1920: **13.3 MB for a
  10-minute talk** (534 chunks, 452 stills, `test_reply_size_for_a_ten_minute_edit`). Fine for
  short-form; serving stills over HTTP is the follow-up if long edits matter. The call's timeout
  grows with the number of words.
- The web refetches only when the stills could change (`captionStillsSignature`: the captions,
  canvas, rate and end; with no caption items also the cut and finished transcriptions), keeps
  the previous stills with an "Updating captions…" note meanwhile, and swaps the `<img>` from the
  player's frame clock outside React. A muted caption track has no stills, as it exports nothing.
- Golden `caption-overlay-parity` composites each still on the uncaptioned export and compares it
  with the captioned export at 9:16, 1:1 and 16:9.

Shipped builds need the `alpha` option of the `subtitles` filter in the bundled LGPL FFmpeg
(S7V-016); it is part of FFmpeg's libass filter and needs nothing else.
