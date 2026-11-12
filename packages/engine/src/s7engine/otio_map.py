# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""``edit.json`` v1 ↔ OpenTimelineIO, for "Export for editors" (S7V-040; ADR-005: export only).

``.otio`` keeps everything: each track and item becomes an OTIO track and clip with exact frame
ranges, and what OTIO has no place for rides in ``metadata["s7video"]``, so edit.json → OTIO →
edit.json is an empty diff. The clips' own sound gets a derived audio track, as editors expect,
which the way back skips.

The timelines for FCPXML, FCP7 XML and EDL (``for_editor``) carry only what those adapters can
write: no caption or overlay tracks (both crash the XML writers), no muted tracks, and for EDL
only the first video track. ``dropped`` names, in plain words, what each format loses; the notice
before an export and the job's result both use it, so they always agree.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence
from fractions import Fraction
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

import opentimelineio as otio

from . import timebase
from .fcpx_exact import exact_rate, frames

KEY = "s7video"
CAPTION_GENERATOR = "s7video.caption"
TEXT_GENERATOR = "s7video.text"
FORMATS = ("otio", "fcpxml", "fcp7xml", "edl")
EXTENSIONS = {"otio": "otio", "fcpxml": "fcpxml", "fcp7xml": "xml", "edl": "edl"}
#: The frame size editors open a project at when the file names none.
_EDITOR_DEFAULT = (1920, 1080)
_ITEM_TIMES = ("id", "start", "duration", "in")
_COLOURS = {
    "red": otio.schema.MarkerColor.RED,
    "orange": otio.schema.MarkerColor.ORANGE,
    "yellow": otio.schema.MarkerColor.YELLOW,
    "green": otio.schema.MarkerColor.GREEN,
    "cyan": otio.schema.MarkerColor.CYAN,
    "blue": otio.schema.MarkerColor.BLUE,
    "purple": otio.schema.MarkerColor.PURPLE,
    "magenta": otio.schema.MarkerColor.MAGENTA,
    "pink": otio.schema.MarkerColor.PINK,
    "black": otio.schema.MarkerColor.BLACK,
    "white": otio.schema.MarkerColor.WHITE,
}
_COLOUR_NAMES = {value: key for key, value in _COLOURS.items()}


class EmptyEdit(ValueError):
    """The edit has no video, which the MP4 export refuses too (PO, 2026-11-12)."""


def _time(count: int, rate: Fraction) -> otio.opentime.RationalTime:
    return otio.opentime.RationalTime(count, float(rate))


def _range(start: int, duration: int, rate: Fraction) -> otio.opentime.TimeRange:
    return otio.opentime.TimeRange(_time(start, rate), _time(duration, rate))


def _plain(value: Any) -> Any:
    """OTIO metadata (AnyDictionary, AnyVector) as plain JSON values."""
    if isinstance(value, Mapping):
        return {str(key): _plain(entry) for key, entry in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str):
        return [_plain(entry) for entry in value]
    return value


def media_path(entry: dict[str, Any], project_dir: str) -> str:
    """The original file: the recorded reference, or a copied ``assets/`` file in the project.

    Never a proxy, and never resolved outside the project.
    """
    if entry.get("reference") is not None:
        return str(entry["reference"])
    root = os.path.realpath(project_dir)
    path = os.path.realpath(os.path.join(root, entry["path"]))
    if os.path.commonpath([root, path]) != root:
        raise ValueError(f'media "{entry["id"]}" is outside the project')
    return path


def _file_url(path: str) -> str:
    return PurePosixPath(path).as_uri()


def url_path(url: str) -> str:
    """A ``file://`` URL written by ``_file_url`` back to its path."""
    return unquote(urlparse(url).path)


def first_video_items(edit: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = [track for track in edit["tracks"] if track["kind"] == "video"]
    return sorted(tracks[0]["items"], key=lambda item: item["start"]) if tracks else []


def _check_not_empty(edit: dict[str, Any]) -> None:
    if not first_video_items(edit):
        raise EmptyEdit("the edit has no video to export")


def _sequential(track: dict[str, Any]) -> list[dict[str, Any]]:
    """The track's items in time order; OTIO tracks cannot overlap, and edit.json forbids it too."""
    items = sorted(track["items"], key=lambda item: item["start"])
    for before, after in zip(items, items[1:]):
        if before["start"] + before["duration"] > after["start"]:
            raise ValueError(f'items "{before["id"]}" and "{after["id"]}" overlap on track "{track["id"]}"')
    return items


class _Builder:
    def __init__(self, edit: dict[str, Any], project_dir: str, *, full: bool) -> None:
        self.edit = edit
        self.rate = timebase.from_rational(edit["fps"])
        self.media = {entry["id"]: entry for entry in edit["media"]}
        self.project_dir = project_dir
        self.full = full

    def reference(self, media_id: str | None) -> otio.core.MediaReference:
        entry = self.media.get(media_id) if media_id is not None else None
        if entry is None:
            return otio.schema.MissingReference()
        length = (entry.get("probe") or {}).get("durationFrames")
        available = _range(0, int(length), self.rate) if length else None
        return otio.schema.ExternalReference(
            target_url=_file_url(media_path(entry, self.project_dir)), available_range=available
        )

    def clip_name(self, item: dict[str, Any]) -> str:
        if self.full:
            return item["id"]
        # The editors' clip names: the file's own, as they would show it. The FCPXML adapter puts
        # names in XPath queries between single quotes.
        entry = self.media.get(item.get("media", ""))
        if entry is None:
            return item["id"]
        name = entry.get("label") or PurePosixPath(entry.get("reference") or entry["path"]).stem
        return str(name).replace("'", "’") or item["id"]

    def clip(self, track: dict[str, Any], item: dict[str, Any], index: int) -> otio.schema.Clip:
        if track["kind"] == "caption":
            reference: otio.core.MediaReference = otio.schema.GeneratorReference(
                generator_kind=CAPTION_GENERATOR, parameters={"text": item["text"]}
            )
        elif track["kind"] == "overlay" and item.get("media") is None:
            reference = otio.schema.GeneratorReference(generator_kind=TEXT_GENERATOR, parameters={"text": item.get("text", "")})
        else:
            reference = self.reference(item.get("media"))
        clip = otio.schema.Clip(
            name=self.clip_name(item),
            media_reference=reference,
            source_range=_range(int(item.get("in", 0)), int(item["duration"]), self.rate),
        )
        if self.full:
            rest = {key: value for key, value in item.items() if key not in _ITEM_TIMES}
            clip.metadata[KEY] = {"index": index, "hasIn": "in" in item, "item": rest}
        return clip

    def track(self, track: dict[str, Any], items: list[dict[str, Any]] | None = None) -> otio.schema.Track:
        kind = otio.schema.TrackKind.Audio if track["kind"] in ("sfx", "music") else otio.schema.TrackKind.Video
        out = otio.schema.Track(name=track["id"], kind=kind)
        if self.full:
            rest = {key: value for key, value in track.items() if key not in ("id", "items")}
            out.metadata[KEY] = {"track": rest}
            out.enabled = not track.get("muted")
        index = {id(item): position for position, item in enumerate(track["items"])}
        at = 0
        for item in items if items is not None else _sequential(track):
            if item["start"] > at:
                out.append(otio.schema.Gap(source_range=_range(0, item["start"] - at, self.rate)))
            out.append(self.clip(track, item, index[id(item)]))
            at = item["start"] + item["duration"]
        return out

    def source_audio(self, track: dict[str, Any]) -> otio.schema.Track | None:
        """The video items' own sound as a linked audio track, as editors expect; muted items are left
        out, as the MP4 leaves them silent."""
        if track.get("muted"):
            return None
        heard = [
            item
            for item in _sequential(track)
            if not item.get("muted") and (self.media.get(item["media"]) or {}).get("probe", {}).get("hasAudio")
        ]
        if not heard:
            return None
        out = otio.schema.Track(name=f"{track['id']}-audio", kind=otio.schema.TrackKind.Audio)
        out.metadata[KEY] = {"derived": "source-audio", "of": track["id"]}
        at = 0
        for item in heard:
            if item["start"] > at:
                out.append(otio.schema.Gap(source_range=_range(0, item["start"] - at, self.rate)))
            out.append(
                otio.schema.Clip(
                    name=self.clip_name(item),
                    media_reference=self.reference(item["media"]),
                    source_range=_range(int(item["in"]), int(item["duration"]), self.rate),
                )
            )
            at = item["start"] + item["duration"]
        return out

    def marker(self, marker: dict[str, Any], start: int | None = None) -> otio.schema.Marker:
        out = otio.schema.Marker(
            name=marker["label"],
            marked_range=_range(marker["start"] if start is None else start, int(marker["duration"]), self.rate),
            color=_COLOURS.get(marker.get("color", ""), otio.schema.MarkerColor.PURPLE),
        )
        if self.full:
            out.metadata[KEY] = {"id": marker["id"], "hasColor": "color" in marker}
        return out


def to_otio(edit: dict[str, Any], project_dir: str, name: str) -> otio.schema.Timeline:
    """The whole edit as OTIO, with everything OTIO has no place for in ``metadata["s7video"]``."""
    _check_not_empty(edit)
    builder = _Builder(edit, project_dir, full=True)
    timeline = otio.schema.Timeline(name=name)
    timeline.metadata[KEY] = {
        "version": edit["version"],
        "fps": edit["fps"],
        "canvas": edit["canvas"],
        "media": edit["media"],
        "metadata": edit["metadata"],
    }
    first_video = next(track for track in edit["tracks"] if track["kind"] == "video")
    for track in edit["tracks"]:
        timeline.tracks.append(builder.track(track))
        if track is first_video and (audio := builder.source_audio(track)) is not None:
            timeline.tracks.append(audio)
    for marker in edit["markers"]:
        timeline.tracks.markers.append(builder.marker(marker))
    return timeline


def from_otio(timeline: otio.schema.Timeline) -> dict[str, Any]:
    """The edit back from ``to_otio``'s timeline: frames from OTIO's ranges, the rest from metadata."""
    head = _plain(timeline.metadata[KEY])
    rate = timebase.from_rational(head["fps"])

    def count(time: otio.opentime.RationalTime) -> int:
        return frames(time.rescaled_to(float(rate)).value)

    tracks: list[dict[str, Any]] = []
    for track in timeline.tracks:
        info = _plain(track.metadata.get(KEY, {}))
        if "derived" in info:
            continue
        items: list[tuple[int, dict[str, Any]]] = []
        for child in track:
            if not isinstance(child, otio.schema.Clip):
                continue
            meta = _plain(child.metadata[KEY])
            placed = track.range_of_child(child)
            item: dict[str, Any] = {
                "id": child.name,
                "start": count(placed.start_time),
                "duration": count(child.source_range.duration),
                **meta["item"],
            }
            if meta["hasIn"]:
                item["in"] = count(child.source_range.start_time)
            items.append((meta["index"], item))
        tracks.append({"id": track.name, **info["track"], "items": [item for _, item in sorted(items, key=lambda pair: pair[0])]})
    markers = []
    for marker in timeline.tracks.markers:
        meta = _plain(marker.metadata[KEY])
        out: dict[str, Any] = {
            "id": meta["id"],
            "start": count(marker.marked_range.start_time),
            "duration": count(marker.marked_range.duration),
            "label": marker.name,
        }
        if meta["hasColor"]:
            out["color"] = _COLOUR_NAMES[marker.color]
        markers.append(out)
    return {
        "version": head["version"],
        "fps": head["fps"],
        "canvas": head["canvas"],
        "media": head["media"],
        "tracks": tracks,
        "markers": markers,
        "metadata": head["metadata"],
    }


def _shown(track: dict[str, Any]) -> bool:
    return bool(track["items"]) and not track.get("muted")


def for_editor(edit: dict[str, Any], project_dir: str, name: str, fmt: str) -> otio.schema.Timeline:
    """The timeline an FCPXML, FCP7 XML or EDL adapter can write: what plays, with no captions or
    overlays, and for EDL the first video track only."""
    _check_not_empty(edit)
    builder = _Builder(edit, project_dir, full=False)
    timeline = otio.schema.Timeline(name=name)
    videos = [track for track in edit["tracks"] if track["kind"] == "video"]
    first = videos[0]
    timeline.tracks.append(builder.track(first))
    if fmt != "edl":
        for track in videos[1:]:
            if _shown(track):
                timeline.tracks.append(builder.track(track))
        if (audio := builder.source_audio(first)) is not None:
            timeline.tracks.append(audio)
        for track in edit["tracks"]:
            if track["kind"] in ("sfx", "music") and _shown(track):
                timeline.tracks.append(builder.track(track))
    if fmt == "edl":
        for clip in timeline.tracks[0]:
            if isinstance(clip, otio.schema.Clip):
                # A reel name is up to 8 letters and digits; the file name, not its encoded URL.
                clip.metadata["cmx_3600"] = {"reel": re.sub(r"[^A-Za-z0-9]", "", clip.name)[:8] or "AX"}
    if fmt == "fcp7xml":
        for marker in edit["markers"]:
            timeline.tracks.markers.append(builder.marker(marker))
        return timeline
    # FCPXML drops markers on the stack and EDL writes only clip markers: each goes onto the clip
    # under it, in that clip's source frames.
    clips = [child for child in timeline.tracks[0] if isinstance(child, otio.schema.Clip)]
    items = _sequential(first)
    for marker in edit["markers"]:
        for clip, item in zip(clips, items):
            if item["start"] <= marker["start"] < item["start"] + item["duration"]:
                placed = builder.marker(marker, int(item["in"]) + marker["start"] - item["start"])
                # FCPXML reads red as a to-do and green as done; colours are listed as lost instead.
                placed.color = otio.schema.MarkerColor.PURPLE
                clip.markers.append(placed)
                break
    return timeline


# --- What does not carry over ------------------------------------------------------------------


def _all_items(edit: dict[str, Any], *kinds: str) -> list[dict[str, Any]]:
    return [item for track in edit["tracks"] if track["kind"] in kinds and not track.get("muted") for item in track["items"]]


def _markers_on_gaps(edit: dict[str, Any]) -> int:
    items = first_video_items(edit)
    return sum(
        1
        for marker in edit["markers"]
        if not any(item["start"] <= marker["start"] < item["start"] + item["duration"] for item in items)
    )


def missing_media(edit: dict[str, Any], project_dir: str) -> list[str]:
    """Media the export points at that is not on disk, by label or id (never by path)."""
    used = {item.get("media") for track in edit["tracks"] for item in track["items"]}
    missing = []
    for entry in edit["media"]:
        if entry["id"] not in used:
            continue
        try:
            found = os.path.isfile(media_path(entry, project_dir))
        except ValueError:
            found = False
        if not found:
            missing.append(str(entry.get("label") or entry["id"]))
    return missing


def dropped(edit: dict[str, Any], fmt: str, captions: str, caption_chunks: int, project_dir: str) -> list[str]:
    """What the export will not carry, in plain words, in a stable order."""
    _check_not_empty(edit)
    out: list[str] = []
    if fmt != "otio":
        sound = _all_items(edit, "video", "sfx", "music")
        if any(item.get("gainDb") or item.get("fadeInFrames") or item.get("fadeOutFrames") for item in sound):
            out.append("volume changes and fades")
        if any(track["kind"] == "music" and track.get("duck") and _shown(track) for track in edit["tracks"]):
            out.append("music dipping under speech (ducking)")
        if any(item.get("zoom") for item in _all_items(edit, "video")):
            out.append("zooms")
        if _all_items(edit, "overlay"):
            out.append("overlays (text and pictures over the video)")
        videos = [track for track in edit["tracks"] if track["kind"] == "video"]
        probes = {entry["id"]: entry.get("probe") or {} for entry in edit["media"]}
        if fmt == "edl":
            if any(_shown(track) for track in videos[1:]):
                out.append("video tracks after the first (an EDL has one)")
            if _all_items(edit, "sfx", "music") or any(probes[item["media"]].get("hasAudio") for item in first_video_items(edit)):
                out.append("all sound: the clips' own audio, sound effects and music (this EDL is picture only)")
        width, height = int(edit["canvas"]["width"]), int(edit["canvas"]["height"])
        if (width, height) != _EDITOR_DEFAULT:
            out.append(f"the frame shape ({width}×{height}): the editor opens its own default size")
        if any(
            (probes[item["media"]].get("width"), probes[item["media"]].get("height")) != (width, height)
            for item in _all_items(edit, "video")
        ):
            out.append("fitting each clip to the frame (fill and crop)")
        if edit["markers"]:
            out.append("marker colours")
            if fmt != "fcp7xml" and (gaps := _markers_on_gaps(edit)):
                out.append(f"{gaps} marker{'s' if gaps != 1 else ''} on a gap with no clip under {'them' if gaps != 1 else 'it'}")
        if any(
            track.get("muted") and track["items"] for track in edit["tracks"] if track["kind"] != "caption" and track is not videos[0]
        ):
            out.append("muted tracks (left out, as in the video export)")
        if caption_chunks:
            out.append("captions on the timeline (they are in the captions file beside it)" if captions != "none" else "captions (no captions file chosen)")
    if caption_chunks and captions == "srt":
        out.append("the caption look (an SRT file has no style; choose ASS to keep it)")
    if caption_chunks and captions == "ass":
        out.append("the caption font, Inter Bold, is named in the ASS file but not included")
    if captions != "none" and not caption_chunks:
        out.append("no captions file: the edit shows no captions")
    out.extend(f"missing media: {name} (the file is not on disk)" for name in missing_media(edit, project_dir))
    return out
