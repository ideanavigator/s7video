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
thumbnail is written next and the list is published again, so the row picks it up without a
reload; a failed thumbnail leaves the film placeholder. The clip is marked as proxy-checked before
the edit lands, or the list that edit triggers would probe the file a second time while the import
decides its proxy (S7V-064).

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

## Where things live

Copies go to `assets/<name>.<ext>`, named from the file (a chat attachment by the name it was sent with, not its stored id), which the project's whitelist `.gitignore`
ignores, so the edit history's media guard never sees them. The final name is taken with a hard
link, an exclusive create: a kept copy of a removed clip or a concurrent same-name import is never
replaced, and the name moves on to `<name>-2`. A media counts as present only when the file at its
path still has its fingerprint, so an undo to an older entry never plays other bytes. Undo and redo never take a clip out of the list: entries the restored edit lacks are kept. When that leaves the edit as it was (a step over an import; the order of the clip list is ignored, since kept clips go to the end), the agent's `video_undo` / `video_redo` reply says nothing on the timeline changed and whether there is more to step, but the step is still taken. `EditDocumentService.step` decides this inside the project's lock (S7V-063). Thumbnails and proxies go to `.s7cache/thumbs/` and
`.s7cache/proxies/`, named by the media's fingerprint. Import and proxy progress live in memory and
`media.subscribe`, never in `edit.json`.
