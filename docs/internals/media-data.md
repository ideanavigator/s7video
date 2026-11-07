<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Waveforms and filmstrips

The timeline's media data (S7V-035): `methods/peaks.py` and `methods/filmstrip.py` in the engine,
started by `MediaLibraryService`, served by the `project-media` route and drawn by
`apps/web/src/components/editor/timeline/` (`ClipMediaTiles`, `mediaTiles*.ts`). The shapes below
are the contract the timeline codes against; their schemas are `MediaPeaksIndex`,
`MediaFilmstripIndex` and `MediaDataState` in `packages/contracts/src/media.ts`.

## One job per media, two steps

Import (and the first list after a restart, for media from before S7V-035) starts one
`media-data` engine job: `media.peaks`, then `media.filmstrip`. `EngineService.mediaData` gives
both calls the same job id and maps their progress into one bar (the waveform is the first 10 %).
A cancel stops whichever step runs; one that lands between the steps stops the second before it
starts. Media with no sound skips the waveform, audio-only media skips the filmstrip, and a
finished index for the fingerprint is reused, so a re-import decodes nothing. Engine progress is
reported every 1 %, since each report republishes the media list.

`MediaAsset.mediaData` says `none | preparing | ready | failed` like `proxy`, with `jobId` and
`progress` while preparing, plus `peaks` and `filmstrip` each `ready | pending | none`. The
waveform is ready before the filmstrip, so the timeline fetches each part as soon as it says
`ready`. `none` is the marker for "this media has no sound" (or no picture): nothing to draw.

## Files

Everything lives in the project's ignored `.s7cache/`, named by the media's sha256, so none of it
enters git, a checkpoint or `.s7history/`:

| File                              | Part        | Contents                                                                                       |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `peaks/<sha256>/index.json`       | `index`     | `version: 1`, `audio`, `sampleRate` (48,000), `durationSamples`, `offsetSamples`, `levels[]`   |
| `peaks/<sha256>/<n>.f32`          | `p<n>`      | `count` little-endian float32 `[min, max]` pairs, `n` mono samples per pair                    |
| `filmstrip/<sha256>/index.json`   | `index`     | `version: 1`, `rate`, `tileWidth`, `tileHeight`, `columns`, `rows`, `levels[]` with `frames[]` |
| `filmstrip/<sha256>/<s>s-<k>.jpg` | `f<s>s-<k>` | sheet `k` (from 1) of the `s`-second level: `columns` x `rows` tiles                           |

Peak levels are 256, 1,024, 4,096 and 16,384 samples per pair; each coarser level is the min/max
of four finer pairs, so they nest exactly. Pair `i` covers samples `[i, i + 1) * n` from the first
audio sample, which sits `offsetSamples` after the video's first frame.

Filmstrip levels keep one frame per 16, 4 and 1 seconds: the first frame at or after each
multiple from the video's first frame. Tiles are 90 px high, as wide as the display aspect needs
(160 for 16:9). Tile `i` of a level shows frame `frames[i]`, an integer at `rate` (the media's own
rate) taken from the frame's real PTS, so VFR footage indexes correctly; it sits on sheet
`floor(i / (columns * rows)) + 1` at row `floor(i / columns) % rows`, column `i % columns`. The
filmstrip reads the proxy when there is one (its frame N is the original's frame N).

Each file is written into a `.tmp-<uuid>/` folder beside it, moved into place, and the index
written last, after the old index is removed. An index of the current `version` therefore means
every file it names is complete; a cancel or a full disk deletes the temp folder and leaves no
file with a final name (a full disk is an output error saying so). A temp folder over 6 hours old
was left by a crashed or killed run and is swept by the next run. Bumping `version` makes the
server recompute. FFmpeg's log is read as bytes and decoded leniently, since it prints metadata
tags as the file stores them, and FFmpeg is killed on any failure, not only a cancel.

## Why one decode for every filmstrip level

Decoding is the whole cost: on 30 minutes of 1080p30 (M4 Max) one pass that keeps a frame per 16 s
took 8.2 s, and one pass that `split`s into all three levels took 8.4 s. So the levels come from
one pass and finish together, instead of coarsest first in three passes. FFmpeg runs at a lower
priority than the app. Sheets are JPEG at `-q:v 2`: at 160x90 a tile scores SSIM ~0.987 against
its frame, ~0.983 at 3 and ~0.972 at 5, against the 0.98 floor the golden enforces.

## Serving

`project-media` takes an optional `part`, required for `peaks` and `filmstrip` and refused for
the other variants, and carried in the signed `project-media-exact` claims. `resolveVariant` maps
the part to a file inside that media's own cache folder and real-path checks it there. Peak
levels are fetched by HTTP range, 2,048 pairs (16 KiB) at a time.

## Drawing

`ClipMediaTiles` renders a canvas only once its part is `ready`, and hands it to one shared worker
with `transferControlToOffscreen` (checked in Electron 44.10.0, Chromium 152). The page posts the
visible span as `firstFrame`, `endFrame` and `anchorFrame` counted from the media's first frame
(source time) at `fps`. Callers pass the edit's document frames and fps; the worker converts them
to samples for the waveform and to the index's own `rate` for the filmstrip, so 25 or 60 fps
media in a 30 fps edit shows the right tiles. The worker asks the page to mint each part's URL.
Signed URLs expire after an hour and stop working when a file is made again, so a failed fetch
mints a fresh URL once (`refresh`) and retries. It fetches only the tiles in view,
keeps them in small LRU caches, and redraws at most once a frame. The waveform uses the coarsest
level with at least one pair per pixel; the filmstrip uses the coarsest level whose tiles sit no
further apart than one slot, and fills slots edge to edge from the clip's left edge. Work on
either thread scales with the canvas width, never the media's length.
