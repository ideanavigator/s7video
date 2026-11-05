<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Media fixtures

No audio or video is committed here. `pnpm media:fetch` downloads each clip in
[manifest.json](manifest.json) into the test-media cache (`$S7VIDEO_TEST_MEDIA_DIR`, or
`~/Library/Caches/s7video-test-media/`) and checks its sha256 and size; a mismatch fails and leaves
nothing in the cache. `pnpm licenses:check` fails if a clip or model weights are ever tracked.
Clear the cache with `rm -rf ~/Library/Caches/s7video-test-media`.

Every clip is CC0-1.0 or CC-BY-4.0 (the licence allowlist); a CC-BY-4.0 clip carries the attribution
below wherever it is shown. Never client footage, and never anyone's private media.

## Downloaded clips

### `talking-head-01`

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title       | WikiConference North America - 2025 - Jiaxu Zhao - Wikipedia's Arbitration Committee                                                                               |
| Speaker     | Jiaxu Zhao, a public talk recorded at WikiConference North America 2025 (New York, 2025-10-18)                                                                     |
| Author      | Lane Rasberry ([User:Bluerasberry](https://commons.wikimedia.org/wiki/User:Bluerasberry)); videography by Rabbit Hole Productions, LLC                             |
| Source page | [Wikimedia Commons file page](https://commons.wikimedia.org/wiki/File:WikiConference_North_America_-_2025_-_Jiaxu_Zhao_-_Wikipedia%27s_Arbitration_Committee.webm) |
| Licence     | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), stated on the source page (`{{self\|cc-by-4.0}}`)                                                       |
| File        | The original upload: WebM, AV1 1894x1080 at 24000/1001 fps (3,356 frames, 140.0 s), Opus 48 kHz stereo; 12,247,260 bytes                                           |
| sha256      | `54ad0a3805394516438f2ba8e7f6ea75a7f77d18d391b8ed1a18e3bc6e1a0722`                                                                                                 |
| Why         | One speaker seated facing the camera, English, natural pauses (over 40 of 250 ms or more), steady room tone around −46 dBFS and no music                           |

Attribution text:

> "WikiConference North America - 2025 - Jiaxu Zhao - Wikipedia's Arbitration Committee" by Lane
> Rasberry (Bluerasberry), videography by Rabbit Hole Productions, LLC, via Wikimedia Commons,
> licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Our files

| File                                                               | What it is                                                                                                                                | Licence |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [manifest.json](manifest.json)                                     | URL, mirrors, sha256, size and licence of each downloaded clip                                                                            | MIT     |
| [talking-head-01.words.json](talking-head-01.words.json)           | 40 hand-marked words of `talking-head-01` with start and end frames, for transcription timing                                             | MIT     |
| [talking-head-01.transcript.json](talking-head-01.transcript.json) | The transcript cache file of one real Qwen3-ASR 1.7B + ForcedAligner run on `talking-head-01` (S7V-026), so export goldens need no models | MIT     |
| [synth.ts](synth.ts)                                               | Generator for deterministic synthetic clips (`testsrc2` video, tone and silence audio)                                                    | MIT     |

### Where the transcript came from

`talking-head-01.transcript.json` is the file the engine's `transcribe.run` wrote to
`.s7cache/transcripts/` for the clip, unchanged apart from indentation (model
`mlx-community/Qwen3-ASR-1.7B-8bit` with the 0.6B ForcedAligner, offline, 2026-11-06). Its
`mediaFingerprint` is the transcript cache key (`apps/server/src/transcript/mediaFingerprint.ts`):
sha256 over the clip's first and last MiB, plus its size. That is not `MediaFiles.fingerprint`
(which also hashes the size first) and not the whole file's sha256 in `manifest.json`. The
`export-transcript-captions` golden checks the key against the cached clip.

### How the words were marked

These are machine-made reference marks, not human ground truth. `pause` and `gap` edges come from
the audio alone; `dip` edges were searched near a speech aligner's word boundary, so they are not
independent of a speech model. `harness.word_timing_diff` therefore scores only `pause`/`gap`
starts by default (36 of the 40 words) and reports the rest:

1. The spoken text comes from the clip's human-made English captions on Commons, cross-checked with
   a one-off local Qwen3-ASR run outside the repo. A word is kept only when both agree.
2. Each edge comes from the audio energy envelope (mono 16 kHz, 100 Hz high-pass, 5 ms RMS, 20 ms
   smoothing; speech is 10 dB over the 5th-percentile floor). `startEdge` and `endEdge` give the
   evidence: `pause` (borders a pause of at least 250 ms), `gap` (borders a shorter quiet stretch),
   or `dip` (an energy minimum at least 6 dB deep between two words, searched within 80 ms of the
   Qwen3-ForcedAligner boundary; the softest kind).
3. The words are phrase-initial or phrase-final, spread across the clip, and each envelope was
   inspected. Frames are `round(seconds × 24000/1001)`; the seconds are kept beside them.

They have not been checked by ear yet: listen to a few (for example "Greetings" at 0.82 s, "vote"
at 82.95 s and "roof" at 135.22 s) before relying on them, and note it here.

## Synthetic clips

`synth.ts` writes clips into `<cache>/synth/`, keyed by a hash of their spec. In TypeScript call
`synthesize(spec)`; from the command line run `node fixtures/media/synth.ts --spec '<JSON>'`; in
pytest use the `synth_clip` fixture. They use the developer's FFmpeg (GPL with libx264, dev only).
