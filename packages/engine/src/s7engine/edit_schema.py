# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Engine-side validation of ``edit.json`` v1 (ADR-005, S7V-024).

Mirrors ``validateEditDocument`` in ``packages/contracts/src/edit.ts``: the version check, the frame
check, the exported JSON Schema (``packages/engine/schema/edit.schema.json``), then the rules a JSON
Schema cannot state. The checks run in the same order so both sides report the same first problem.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

EDIT_DOCUMENT_VERSION = 1
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "edit.schema.json"

#: ``EditZoom``'s ``MAX_ZOOM_RAMP_FRAMES``: one still zoom per ramp frame in the export (S7V-037).
MAX_ZOOM_RAMP_FRAMES = 60

FRAME_KEYS = (
    "start",
    "duration",
    "in",
    "fadeInFrames",
    "fadeOutFrames",
    "durationFrames",
    "rampFrames",
    "attackFrames",
    "releaseFrames",
    "end",
)


@dataclass(frozen=True)
class EditIssue:
    """One problem: the id it is on (``None`` for the document), a reason code and plain words."""

    item_id: str | None
    reason: str
    explanation: str


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _id_of(value: Any, fallback: str | None) -> str | None:
    if isinstance(value, dict) and isinstance(value.get("id"), str):
        return value["id"]
    return fallback


def _label(item_id: str | None) -> str:
    return "The edit" if item_id is None else f'"{item_id}"'


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _frame_issues(raw: dict[str, Any]) -> list[EditIssue]:
    issues: list[EditIssue] = []

    def check(value: Any, owner: str | None) -> None:
        if not isinstance(value, dict):
            return
        for key in FRAME_KEYS:
            frame = value.get(key)
            if not _is_number(frame):
                continue
            whole = math.isfinite(frame) and float(frame).is_integer()
            if not whole or frame < 0:
                shown = int(frame) if whole else frame
                issues.append(
                    EditIssue(
                        owner,
                        "frame",
                        f"{_label(owner)} has {key} {shown}. Times are whole frame numbers, 0 or more.",
                    )
                )
            elif key == "rampFrames" and frame > MAX_ZOOM_RAMP_FRAMES:
                issues.append(
                    EditIssue(
                        owner,
                        "frame",
                        f"{_label(owner)} has rampFrames {int(frame)}. A zoom ramps over at most {MAX_ZOOM_RAMP_FRAMES} frames.",
                    )
                )

    for media in _list(raw.get("media")):
        if isinstance(media, dict):
            check(media.get("probe"), _id_of(media, None))
    for track in _list(raw.get("tracks")):
        if not isinstance(track, dict):
            continue
        track_id = _id_of(track, None)
        duck = track.get("duck")
        if isinstance(duck, dict):
            check(duck, track_id)
            for frame_range in _list(duck.get("ranges")):
                check(frame_range, track_id)
        for item in _list(track.get("items")):
            item_id = _id_of(item, track_id)
            check(item, item_id)
            if isinstance(item, dict):
                check(item.get("zoom"), item_id)
                for word in _list(item.get("words")):
                    check(word, item_id)
    for marker in _list(raw.get("markers")):
        check(marker, _id_of(marker, None))
    return issues


def _owner_at_path(raw: Any, path: list[Any]) -> str | None:
    owner: str | None = None
    node = raw
    for key in path:
        if isinstance(node, dict) and key in node:
            node = node[key]
        elif isinstance(node, list) and isinstance(key, int) and 0 <= key < len(node):
            node = node[key]
        else:
            break
        owner = _id_of(node, owner)
    return owner


def _concerns_discriminator(error: ValidationError) -> bool:
    """A union branch rejected because its ``kind`` literal did not match."""
    return list(error.relative_path) == ["kind"] or (
        error.validator == "required" and "'kind'" in error.message
    )


def _leaf_errors(error: ValidationError) -> list[ValidationError]:
    """Descends into the union branch whose ``kind`` matched, as Effect Schema does."""
    if error.validator != "anyOf" or not error.context:
        return [error]
    branches: dict[Any, list[ValidationError]] = {}
    for sub in error.context:
        branches.setdefault(sub.schema_path[0], []).append(sub)
    matching = [
        errors
        for errors in branches.values()
        if not any(_concerns_discriminator(sub) for sub in errors)
    ]
    if len(matching) != 1:
        return [error]
    leaves: list[ValidationError] = []
    for sub in matching[0]:
        leaves.extend(_leaf_errors(sub))
    return leaves


def _schema_issues(raw: Any) -> list[EditIssue]:
    issues: list[EditIssue] = []
    for error in _validator().iter_errors(raw):
        for leaf in _leaf_errors(error):
            path = list(leaf.absolute_path)
            owner = _owner_at_path(raw, path)
            where = "" if not path else " at " + ".".join(str(part) for part in path)
            issues.append(
                EditIssue(owner, "schema", f"{_label(owner)} is not valid{where}: {leaf.message}.")
            )
    return issues


def _semantic_issues(document: dict[str, Any]) -> list[EditIssue]:
    issues: list[EditIssue] = []
    seen: set[str] = set()

    def claim(entry_id: str) -> None:
        if entry_id in seen:
            issues.append(
                EditIssue(entry_id, "duplicate-id", f"{_label(entry_id)} is used as an id more than once.")
            )
        seen.add(entry_id)

    media: dict[str, dict[str, Any]] = {}
    for entry in document["media"]:
        claim(entry["id"])
        media[entry["id"]] = entry
        path = entry.get("path")
        reference = entry.get("reference")
        if (path is None) == (reference is None):
            issues.append(
                EditIssue(
                    entry["id"],
                    "media-location",
                    f"Media {_label(entry['id'])} needs exactly one of a project path or an outside reference.",
                )
            )
        elif path is not None and (
            path == "" or path.startswith("/") or ".." in re.split(r"[\\/]", path)
        ):
            issues.append(
                EditIssue(
                    entry["id"],
                    "media-location",
                    f"Media {_label(entry['id'])} has a path outside the project. Use a path inside it, or a reference.",
                )
            )
        elif reference is not None and not PurePosixPath(reference).is_absolute():
            issues.append(
                EditIssue(
                    entry["id"],
                    "media-location",
                    f"Media {_label(entry['id'])} has a reference that is not a full path.",
                )
            )
    for marker in document["markers"]:
        claim(marker["id"])

    for track in document["tracks"]:
        claim(track["id"])
        duck = track.get("duck")
        if track["kind"] == "music" and duck is not None:
            for frame_range in duck["ranges"]:
                if frame_range["end"] <= frame_range["start"]:
                    issues.append(
                        EditIssue(
                            track["id"],
                            "duck-range",
                            f"Track {_label(track['id'])} has a ducking range that ends at or before it starts "
                            f"({frame_range['start']} to {frame_range['end']}).",
                        )
                    )
        items = track["items"]
        for item in items:
            claim(item["id"])
            end = item["start"] + item["duration"]
            media_id = item.get("media")
            if track["kind"] == "overlay" and ("text" in item) == (media_id is not None):
                issues.append(
                    EditIssue(
                        item["id"],
                        "overlay-content",
                        f"Overlay {_label(item['id'])} needs exactly one of a media file or text.",
                    )
                )
            if media_id is not None:
                source = media.get(media_id)
                if source is None:
                    issues.append(
                        EditIssue(
                            item["id"],
                            "unknown-media",
                            f'Item {_label(item["id"])} uses media "{media_id}", which is not in this project.',
                        )
                    )
                else:
                    source_in = item.get("in", 0)
                    available = source["probe"].get("durationFrames")
                    if available is not None and source_in + item["duration"] > available:
                        issues.append(
                            EditIssue(
                                item["id"],
                                "source-range",
                                f"Item {_label(item['id'])} reads frames {source_in} to {source_in + item['duration']}, "
                                f'but media "{media_id}" has only {available}.',
                            )
                        )
            if "fadeInFrames" in item or "fadeOutFrames" in item:
                fades = item.get("fadeInFrames", 0) + item.get("fadeOutFrames", 0)
                if fades > item["duration"]:
                    issues.append(
                        EditIssue(
                            item["id"],
                            "fade-range",
                            f"Item {_label(item['id'])} fades for {fades} frames but lasts only {item['duration']}.",
                        )
                    )
            for word in item.get("words", []):
                if word["start"] < item["start"] or word["start"] + word["duration"] > end:
                    issues.append(
                        EditIssue(
                            item["id"],
                            "word-range",
                            f'Caption {_label(item["id"])} has the word "{word["text"]}" outside its own time.',
                        )
                    )
                    break
        ordered = sorted(items, key=lambda entry: (entry["start"], entry["id"]))
        for previous, current in zip(ordered, ordered[1:]):
            if previous["start"] + previous["duration"] > current["start"]:
                issues.append(
                    EditIssue(
                        current["id"],
                        "overlap",
                        f"Item {_label(current['id'])} overlaps {_label(previous['id'])} on track "
                        f"{_label(track['id'])}. Items on one track cannot share frames.",
                    )
                )
    return issues


def validate_edit_document(raw: Any) -> list[EditIssue]:
    """Returns the problems with a parsed ``edit.json``; an empty list means it is valid."""
    version = raw.get("version") if isinstance(raw, dict) else None
    if not _is_number(version) or version != EDIT_DOCUMENT_VERSION:
        known = _is_number(version) and math.isfinite(version) and float(version).is_integer() and version > 0
        return [
            EditIssue(
                None,
                "version",
                f"This edit uses format version {int(version)}; this app reads version {EDIT_DOCUMENT_VERSION}."
                if known
                else "This file has no valid edit format version.",
            )
        ]
    frames = _frame_issues(raw)
    if frames:
        return frames
    structural = _schema_issues(raw)
    if structural:
        return structural
    return _semantic_issues(raw)
