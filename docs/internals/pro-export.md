<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Export for editors

"Export for editors" (S7V-040) hands the edit to a pro editor. The four formats are OpenTimelineIO
(`.otio`), Final Cut Pro XML (`.fcpxml`), FCP7 XML (`.xml`) and a CMX 3600 EDL (`.edl`). The
captions go in a file beside it (`.srt` by default, `.ass` on request). Users start it from the
icon button next to Export, and agents through `video_export_interchange`, only when the user asks.
OTIO is an export format only (ADR-005); nothing reads these files back into s7video.

## The path

- **The engine** has two methods. `interchange.check` answers at once with what the export won't
  carry over. `interchange.export` is a job that writes the files. Both call `otio_map.dropped`,
  so the notice before the export, the tool's start reply and the job's result can't disagree.
  OpenTimelineIO is imported only when a method runs, which keeps the engine's start fast.
- **The server.** `ExportService.startInterchange` reads the project's cached transcripts as
  `start` does, then runs the check. With `check: true` it stops there and writes nothing.
  Otherwise it reserves one free name for every file (`<slug>-<stamp>[-n].fcpxml` and its
  `.srt`) under the naming permit, so two exports in the same minute never pair files.
- **The job.** It writes each file as `.part` and renames them all only after the last cancel
  point, so a cancel or a failure leaves nothing in `exports/`. A finished export marks its
  version (S7V-050), as the MP4 export does.
- **An empty edit** (no tracks, or no video on the first video track) is refused with the MP4
  export's "the edit has no video to export".

## What each format carries

- **`.otio` keeps everything in the file.** Each track and item becomes an OTIO track and clip
  with exact frame ranges. Whatever OTIO has no place for rides in `metadata["s7video"]`: roles,
  caption words and looks, gain, fades, `duck`, `zoom`, overlays, `linkId`, the media table and
  item order. So edit.json → OTIO → edit.json is an empty diff. Captions are clips with a
  `GeneratorReference`. The clips' own sound gets a derived audio track that the way back skips.
- **Lost in Premiere and Resolve, and listed (S7V-097).** Neither editor reads another app's OTIO
  metadata, and OTIO's own schema has no field for gain, fades, ducking, zoom, the canvas or a
  caption look. So OTIO lists the same effects as XML, plus overlay placement and caption clips
  that show no words. Markers, their colours and muted tracks use OTIO's own fields and aren't
  listed.
- **FCPXML, FCP7 XML and EDL** get `otio_map.for_editor`'s timeline: what plays, and nothing the
  adapters can't write.
  - **Left out:** caption and overlay tracks (both crash the XML writers), muted tracks, and
    muted clips' sound. EDL keeps only the first video track and no sound.
  - **Markers:** for FCPXML and EDL each marker moves onto the clip under it, because FCPXML drops
    timeline markers. Colours are lost (FCPXML would read red as a to-do).
  - **Media:** clips reference the original files by `file://` URL, from a project `assets/` path
    or the recorded `reference`, never `.s7cache/` proxies. Names with `'` are changed for the
    FCPXML adapter, which puts them in XPath queries.
- **Lost in XML and EDL, and listed:** gain and fades, ducking, zooms, overlays, the caption look
  (it stays in an ASS file), the frame shape when it isn't 1920×1080, and the fill-and-crop to the
  canvas (PO, 2026-11-12: no canvas in FCPXML). Missing media is listed by label, never by path,
  and the files are still written.
- **Captions** come from the same chunks the MP4 burns in: `export.timeline_plan`, the
  refusal-free half of `plan_segments`, then `export_chunks`. Caption items win, and the clips'
  transcripts are the fallback. SRT has one cue per chunk, with times rounded up to the
  millisecond so an editor reading at the edit's rate lands on the chunk's frame. ASS is
  `captions_ass.build_ass` in the edit's look, which names Inter Bold but doesn't include it.

## The adapter fix and its limits

The three adapters ship unmodified (Apache-2.0). Their quirks are handled on our side:

- **FCPXML frame maths** (`fcpx_exact.py`). The adapter goes through floats with `int()`
  truncation and whole-number rates. At 25 fps it puts 4 of 58 linked-audio clips a frame early
  and misreads 7 of 58 on the way back. At 30000/1001 and 24000/1001 it can't write at all: the
  NTSC frame duration misses its table.
  - `install()` replaces those helpers (three module functions and five class attributes) with
    exact `Fraction` maths, and `format_name`, which runs `ffprobe` from PATH, with an empty name.
    It also stops one event browser clip per timeline clip: the writer tests an XML element's
    truth, and an element with no children is false.
  - It patches only adapter 1.0.0, and refuses another version until it is checked again. The
    upstream offer is the PO's, after Sprint 05.
- **FCP7 XML** loads only as an OTIO plugin, because its imports are relative. So it is called by
  adapter name (`fcp_xml`), not as a module.
- **EDL at 29.97 fps** writes drop-frame timecode (`;`). OTIO's own EDL reader parses markers'
  `LOC` lines only with `:`, so markers don't read back at that rate. The cuts still read back
  exactly. Reading an EDL needs `rate=`, which defaults to 24.

## Checks

- `packages/engine/tests/test_interchange.py` covers the round trip, the cuts at 25, 30, 29.97 and
  23.976, linked audio, captions against the burned chunks, the refusals, cancel and odd paths.
- The golden `interchange-otio-fcpxml-edl` covers the `talking-head-01` silence cut at its own
  24000/1001 and retimed to 30000/1001.
- No FCPXML DTD is vendored (Apple's terms for it aren't clear). The XML checks are
  well-formedness and read-back. The import into Final Cut Pro and Resolve is a manual check on
  the PO's Mac.
