<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Media import

How a clip gets into a project (S7V-025): `MediaLibraryService` in `apps/server/src/media/`.

## Copy is decided before it starts

A copy into `assets/` is an APFS clone only when the source and the project's `assets/` folder are
on the same device and that device is APFS (`statfs` type `0x1a`). Otherwise it is a streamed copy
that reports progress in the Assets list. Neither failure is detectable after the fact:

- macOS `cp -c` quietly falls back to a full copy across volumes and still exits 0;
- Node's `copyFile` with `COPYFILE_FICLONE` copies the bytes on macOS, and `COPYFILE_FICLONE_FORCE`
  is `ENOSYS` there.

So `cp -c` runs only after the up-front check passes. The original is only ever read.

## Proxies keep the source's timestamps

`media.proxy` encodes with `-copyts`, passthrough frame timing and the source's time base, so its
video packet PTS list equals the original's. A frame picked on the proxy is the same frame in the
original, and renders always read originals. Proxies are made only when `ProxyPolicy` says the
player would struggle (keyframe gap over 2 s in the first 10 s or 5 s from the middle, a codec or container Chromium cannot play smoothly,
above 4K, or 4K above 60 fps); ordinary 4K plays from the original.

## The row comes before its thumbnail

Import records the media in `edit.json` right after the probe and fingerprint (and the copy), so
the Assets row appears before the thumbnail is made: on a 4K clip that is a full-frame decode. The
thumbnail is made next, beside the proxy decision's keyframe scan, and the list is published
again, so the row picks it up without a reload; a failed thumbnail leaves the film placeholder.
The thumbnail runs in the service's scope, so an import cut short after its edit landed (app quit,
closed RPC, stopped tool) still gets one, and importing the same file again makes a missing one.
The clip is marked as proxy-checked before the edit lands, or the list that edit triggers would
probe the file a second time while the import decides its proxy (S7V-064).

## Serving is scoped to `edit.json`

`/api/assets` serves project media through the `project-media` resource. Its token pins the file's
device and inode like `media-file-exact`, and every request asks `MediaLibraryService.resolveVariant`
again, so media removed from that project's `edit.json`, another project's media, and a file swapped
in at the same path are all refused. The generic `media-file` kinds are unchanged.

So whatever records a media entry decides what can be served. Clients and agents' tools cannot
add one except through `MediaLibraryService` (import and relink, which need filesystem read): the
`edit.apply` RPC refuses `putMedia`, which would let an operate-only client record any path on the
machine (S7V-066). A direct write to `edit.json` (an agent's shell, a git restore) is still
accepted as a new revision, media entries included; refusing new media references in such writes
is S7V-054. Originals are also served only with a known video or audio extension.

## Chat drops

Video and audio dropped into a video project's chat import by path (`useChatMediaImport`). A failed
import shows "Couldn't add <name> to Assets" with the same reason the Assets tab shows
(`mediaErrorExplanation.ts`) and Retry for that file, and stays until closed. A failed video is
never attached to the message instead; a failed audio file stays attached, and its toast says so
(S7V-071). The engine runs Python with `-I -B`: `-I` ignores
`PYTHONDONTWRITEBYTECODE`, and `.pyc` writes under the watched `packages/` restart `vp run dev`.

## The canvas follows the first clip

Import adds media only; it never changes the canvas. A new edit starts 1080×1920, and the first
clip placed on an empty timeline (today only by silence removal) sets the canvas to that clip's
display shape, long side at most 1920, sides even (`canvasForClip.ts`), in the same checkpoint as
the cut, so one undo takes both back. Later placements never change it, and nor does the first
one once a shape was chosen (`metadata.canvasChosen`, set by any `setCanvas` not `fromClip`). The user changes it only
on request, to 9:16, 16:9, 1:1, 4:5 or 4:3 (`video_canvas`, a `setCanvas` op). Export renders at
the canvas, filling and cropping from the centre, and the player shows the same crop inside its
16:9 frame, so the agent's `video_export` takes no shape of its own (S7V-061).

## Where things live

Copies go to `assets/<name>.<ext>`, named from the file (a chat attachment by the name it was sent with, not its stored id), which the project's whitelist `.gitignore`
ignores, so the edit history's media guard never sees them. The final name is taken with a hard
link, an exclusive create: a kept copy of a removed clip or a concurrent same-name import is never
replaced, and the name moves on to `<name>-2`. A media counts as present only when the file at its
path still has its fingerprint, so an undo to an older entry never plays other bytes. Undo and redo never take a clip out of the list: entries the restored edit lacks are kept. When that leaves the edit as it was (a step over an import; the order of the clip list is ignored, since kept clips go to the end), the agent's `video_undo` / `video_redo` reply says nothing on the timeline changed and whether there is more to step, but the step is still taken. `EditDocumentService.step` decides this inside the project's lock (S7V-063). Making an older version current (S7V-069) follows the same rule: clips in Assets now stay. Thumbnails and proxies go to `.s7cache/thumbs/` and
`.s7cache/proxies/`, named by the media's fingerprint. Import and proxy progress live in memory and
`media.subscribe`, never in `edit.json`. Waveforms and filmstrips go to `.s7cache/peaks/` and
`.s7cache/filmstrip/` the same way ([media-data.md](media-data.md)).

Transcripts go to `.s7cache/transcripts/<sha256>.json`. The transcribe job also writes the clip's
per-frame sound levels beside it, as `<sha256>.levels.json`, before the transcript, from the audio it
already decoded (S7V-055). Silence removal uses that file only when its fingerprint, frame rate and
frame count match the transcript; otherwise a `silence.detect` job measures the clip once and
writes it. The agent tool waits up to 20 s for that job, then hands back its id, so a slow disk
never hits an agent's tool time limit. Levels are summed in 1 Mi-sample blocks with the running
total carried over, which gives the same integers as one whole-clip sum without a 64-bit copy of
the audio (about 460 MB for 30 minutes).
