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
player would struggle (keyframe gap over 2 s, a codec or container Chromium cannot play smoothly,
above 4K, or 4K above 60 fps); ordinary 4K plays from the original.

## Serving is scoped to `edit.json`

`/api/assets` serves project media through the `project-media` resource. Its token pins the file's
device and inode like `media-file-exact`, and every request asks `MediaLibraryService.resolveVariant`
again, so media removed from that project's `edit.json`, another project's media, and a file swapped
in at the same path are all refused. The generic `media-file` kinds are unchanged.

## Where things live

Copies go to `assets/<media id>.<ext>`, which the project's whitelist `.gitignore` ignores, so the
edit history's media guard never sees them. Thumbnails and proxies go to `.s7cache/thumbs/` and
`.s7cache/proxies/`, named by the media's fingerprint. Import and proxy progress live in memory and
`media.subscribe`, never in `edit.json`.
