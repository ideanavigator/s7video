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
  its words in timeline frames. The mapping is `packages/shared/src/captionWords.ts`, a port of
  the engine's `map_words`; `captionWordsParity.test.ts` runs both on the same edits and requires
  every word to be equal. Change one, change the other.
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
- Undo, redo and "make current" restore whole documents, captions included; they never rebuild.
- Caption rows are read-only on the timeline: a press on one seeks, and split and delete skip
  them (the rows are `locked` in the timeline model).

## The player overlay

The player shows stills drawn by the export's own renderer, so the preview cannot drift from the
export (PO, 2026-11-06). Spike A4 measured HTML text against libass at 0.86 SSIM in the caption
band; the same ASS through the same libass is pixel-equal before scaling.

- The engine's `captions.render` builds the export's chunks (`caption_items`, `caption_chunks`)
  and its ASS (`build_ass`), retimes one distinct text per second, and has FFmpeg's `subtitles`
  filter draw them onto a transparent `color=black@0` canvas (`alpha=1`) as RGBA PNGs. 54 chunks at
  1080×1920 take about 0.2 s on an M4 Max.
- `CaptionStillsService` caches them in `.s7cache/captions/<sha256>/`, keyed by the canvas, rate,
  the video's end (chunks are clipped to it) and the caption tracks, and keeps the newest 12. Undo
  back to earlier captions is a cache hit. The stills travel inline (base64) in the
  `captions.stills` result: one round trip instead of one signed URL per still, about 20 KB each.
- The web refetches only when that same key's inputs change (`captionStillsSignature`), keeps the
  previous stills with an "Updating captions…" note meanwhile, and swaps the `<img>` from the
  player's frame clock outside React. A muted caption track has no stills, as it exports nothing.
- Golden `caption-overlay-parity` composites each still on the uncaptioned export and compares it
  with the captioned export at 9:16, 1:1 and 16:9.

Shipped builds need the `alpha` option of the `subtitles` filter in the bundled LGPL FFmpeg
(S7V-016); it is part of FFmpeg's libass filter and needs nothing else.
