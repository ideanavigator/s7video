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
  the cut moved the clip (a move shifts it; a trim, cut or delete clips or drops it). **Every
  carried caption lies inside one video item**, and its words map through that item: words that
  land in another item, or moved by another amount, start a new caption, so no caption spans a
  hole or another clip. A word goes through the item it came from (same id) while that item
  still shows it; only a split's new half or a delete falls back to another item of the clip, and
  never to one that showed those frames before, so a repeated part keeps both copies. Only a
  word that would share a frame with another caption is dropped,
  so the track always validates (`captionCarry.test.ts`, 500 seeds with 2-3 unreadable clips). The player names the clip ("No transcript for …").
- Undo, redo and "make current" restore whole documents, captions included; they never rebuild.
- Caption rows are read-only on the timeline: a press on one seeks, and split and delete skip
  them (the rows are `locked` in the timeline model).

## Caption looks (S7V-037)

The looks are ours: `s7-neutral` (Plain, the default), `s7-box` (Boxed), `s7-karaoke`
(Highlighted word) and `s7-minimal` (Minimal), all Inter Bold, the one bundled OFL font.

- **The folder is the registry.** Each look is a JSON file in the engine's `styles/captions/`;
  `load_style` reads only `s7-*` ids found there and refuses the rest ("is not one of ours"), and
  a look whose font isn't bundled fails plainly instead of falling back to a system font. The app's
  list (`CaptionPresetId`, with the plain names) is in `contracts/engine.ts`; a server test keeps
  the two the same. Optional keys: `box` (border style 3, the padding as the outline width),
  `outline`, `highlight`. Every look keeps the platforms' safe zone; margins grow by the outline or
  padding (plus its anti-aliased pixel) and the shadow, and keep a pixel of slack left and right
  of every line, because libass fits a line's advance to the margins and anti-aliasing and side
  bearings put up to a pixel of ink past it. So the whole caption stays inside (golden
  `zoom-crop-presets` checks every still's pixels).
- **One look per edit.** The export, the stills and the server read the same rule
  (`export.caption_style`, `captionLookOf`): the first shown caption track with items that names
  a look, else a shown caption track's (the transcript track before its clips have words), else
  `s7-neutral`. The look lives on the track, not its items: rebuilds replace only items, so a look
  survives every cut. The track's `custom` (S7V-099, below) is read by the same rule
  (`export.caption_custom`, `captionCustomOf`).
- **Picking a look on an edit with no captions adds them** in that look, in the same change (PO,
  2026-11-12): `CaptionTrackService.setStyle` runs `captionTrackOps` and `setCaptionStyle` in
  one apply. An empty unmarked track would not be the one "add captions" rebuilds, and a later
  "add captions" would add a second track without the look. The `video_caption_style` tool uses it.
- **The highlighted look shows each chunk once per word being said**, the word in the accent
  colour until the next word starts: one ASS event per word state (`captions_ass.cues`). ASS `\k`
  karaoke was not used: it times syllables in centiseconds from the event's start, so a word's
  switch can land a frame off, and it leaves earlier words lit. Word states start on frame
  boundaries with `frame_to_ms`, as every chunk does, and they are exactly the stills the player
  needs. A 10-minute talk has at most four times the entries of the plain look, and the reply stays
  under 200 KB (`CaptionStillsService.test.ts`).
- **Previews** (`captions.preview`) draw a sample line on a flat slate frame at the project's
  canvas with the same ASS builder and libass, cut to the caption band and shrunk to 240 px, so
  every shape shows the same text size. Each sits in its look's cache folder as
  `preview-<16 hex>.png`. Golden `zoom-crop-presets` compares each with the exported frame of the
  same caption.

## Captions in the chat (S7V-099)

The Editor has no caption controls (the PO called S7V-037's look strip "really bad UX"): the user
shapes captions by talking to the agent, through `video_caption_style` and `video_add_captions`.

- **The looks in the chat.** `video_caption_style` with neither `preset` nor `custom` changes
  nothing and answers with the four looks: each name, then its preview on a line of its own (a
  markdown hard break), so the pictures line up at any width. A preview is a markdown image of
  its real path (`CaptionStillsService.previews`, opened no-follow like the stills); the chat's
  markdown draws a local path through its own signed `media-file` URL each time, in Claude and
  Codex threads alike. Not S7V-079's still URL: its token expires, and a chat message is kept for
  good. For the same reason previews live in `.s7cache/captions/previews/<look>/`, which the
  stills' pruning never touches: custom styles add look folders, and four previews would
  otherwise be pruned after a restyle or two. They draw on a flat slate, not the user's video
  (a later card).
- **Styles in words.** `custom` holds `textColor`, `highlightColor`, `boxColor` (`#RRGGBB`),
  `size` (0.6–1.6) and `position` (`top`, `middle`, `bottom`) on the caption track, beside its
  look. `captions_ass.styled` applies it to the look's file before the ASS is built, so the
  export, the player's stills (whose look folder hashes it) and the editors' `.ass` draw it the
  same way; golden `caption-overlay-parity` covers two custom styles. A custom box colour is
  solid: each line of a caption has its own box, and two see-through boxes show a seam where they
  overlap. A track without `custom` hashes and draws exactly as before. The tool's schema
  advertises `custom` as a bare object (its fields would cost about 250 B on every turn); the
  handler checks each field and refuses anything else by naming what can change, a box or
  lit-word colour on a look that has none included (`CAPTION_LOOK_PARTS`, kept in step with the
  style files by a test). The `caption-style` skill names the fields. A new `custom` merges into
  the track's own; the look's own size and the bottom are stored as nothing.
- **Editing words, not codes.** Replies and version notes name the skill's colours ("orange",
  "blue box"; any other is "a custom colour") and say a size as "bigger" or "a bit smaller"
  (`describeCaptionCustom`). They don't count captions: a caption item is a run of a clip, not a
  line the player shows.
- **Captions already in the picture.** The transcribe job reads ten frames with Apple Vision
  (`burned_in.py`, on the device, in the language Vision detects; text without spaces matches
  by character) and stores `burnedInCaptions` (`found`, `confidence`, `region`) with the
  transcript, never the text. It decides by variety: enough frames show a line that is mostly
  the words being said, and at least two different lines match. A sign or name card is one line,
  and a line in nearly every frame is part of the picture. Each input decodes on one thread (ten
  default decoders peaked at 8.75 GB on 4K HEVC), and any failure leaves the clip unchecked.
- **Asking first.** A clip with `found: true` counts as a yes only once the transcript track
  captions it. Until then `video_add_captions`, `video_caption_style` and the looks refuse
  (`CaptionsError` `burned-in`) unless the call carries `confirm: true`, and a rebuild after a cut
  or a placement leaves that clip out: a clip placed after the captions asks too. The question
  offers the way forward from the region: "This clip already has captions near the bottom. Add
  new ones at the top, add them anyway, or leave it as it is?" A clip transcribed before the
  check behaves as before.

## The player overlay

The player shows stills drawn by the export's own renderer, so the preview cannot drift from the
export (PO, 2026-11-06). Spike A4 measured HTML text against libass at 0.86 SSIM in the caption
band; the same ASS through the same libass is pixel-equal before scaling.

- With no caption items, the export burns in captions from the clips' transcripts (S7V-046), so
  the player shows those too: the server passes the same transcripts the export would
  (`transcriptMediaFor`), and the engine picks the chunks with the export's own `export_chunks`.
  A track and the fallback on the same edit give the same stills (`test_captions.py`).
- The engine's `captions.render` builds the export's chunks and its ASS events in the edit's look
  (`cues`, `build_cues`), retimes one event per second, and has FFmpeg's `subtitles` filter draw
  them twice, over black and over white, as the export draws them over the video. The two give
  each pixel's alpha and colour exactly (a matte: 255·α = 255 − (white − black), colour = black ÷
  α), saved as straight-alpha RGBA PNGs, so a still composited over any frame is what libass
  blends there. **Not `subtitles`' own `alpha=1`:** it blends alpha as one more colour channel, so
  its PNGs held premultiplied colour, and a semi-transparent colour's opacity twice (the boxed
  look's 72 % box came out at 52 %, lighter in the player than in the export; S7V-037).
- The engine keeps the stills in `.s7cache/captions/<look>/<cue>.png`. `look` hashes the canvas
  size, the look's id and style file's bytes, the bundled fonts and `RENDER_VERSION` in
  `methods/captions.py`; `cue` hashes the event's words and its lit word. Timing never changes a
  still, so undo and trims draw nothing, and a cut draws only the cues it makes new; switching
  looks back and forth draws nothing either. **Bump `RENDER_VERSION` when the drawing changes in
  a way those inputs don't show** (the ASS builder's code, the FFmpeg arguments; 2 since S7V-037).
  The newest 4 looks (the four looks at one canvas) and 4,000 stills are kept; drawing happens in
  a `.tmp-*` folder inside the cache, removed on any exit, and never counted.
- `captions.stills` names the stills; it doesn't carry them (S7V-079). Inline base64 was 13.3 MB
  for a 10-minute talk (534 chunks, 452 stills, `test_reply_size_for_a_ten_minute_edit`); the
  names are 38.6 KB (`CaptionStillsService.test.ts`). The reply carries one signed asset URL for
  the look's folder (a `caption-stills` claim, minted by the same read-scope RPC), and a still is
  that URL plus its file name: one token, not one per still. The route serves only a 32-hex-digit
  `.png` in the project's own `.s7cache/captions/<look>/`, opened by its real path with
  `openMediaFile` and streamed from that descriptor, so a link anywhere on the way, or one swapped
  in later, is never read (`captionStillFile.ts`). The call's timeout grows with the number of
  words.
- `<look>/<text>` hashes everything a still's pixels depend on, so the web keeps each still by that
  key as an object URL (`captionStillUrls.ts`): a cut fetches only the stills it makes new, and a
  remount shows cached stills on its first frame. The token changes with each reply, so the HTTP
  cache alone can't do this. The cache is a per-project atom with the reply query's 5-minute idle
  time; its finalizer revokes every URL, so a closed project frees its stills. A still that fails
  to load hides its chunk and is asked for again with the next reply.
- The web refetches only when the stills could change (`captionStillsSignature`: the captions,
  canvas, rate and end; with no caption items also the cut and finished transcriptions), keeps
  the previous stills with an "Updating captions…" note until the new ones are drawn and fetched,
  and swaps the `<img>` from the player's frame clock outside React. A muted caption track has no
  stills, as it exports nothing.
- Golden `caption-overlay-parity` composites each still on the uncaptioned export and compares it
  with the captioned export at 9:16, 1:1 and 16:9, in every look.

Shipped builds need FFmpeg's `subtitles` (libass), `blend`, `negate`, `extractplanes` and
`alphamerge` filters in the bundled LGPL FFmpeg (S7V-016); all are part of FFmpeg's own filters.
