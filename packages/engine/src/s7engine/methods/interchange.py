# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""``interchange.check`` and ``interchange.export``: "Export for editors" (S7V-040).

``interchange.export`` is a job that writes the edit as OpenTimelineIO, FCPXML, FCP7 XML or a CMX
3600 EDL to ``<outputBase>.<ext>``, with the captions beside it as ``<outputBase>.srt`` or ``.ass``
from the same chunks the MP4 export burns in. Each file is written as ``.part`` and renamed only
when all of them are done, so a cancel or a failure leaves nothing in ``exports/``.

``interchange.check`` answers at once with what the export would not carry, for the notice before
it starts; both use ``otio_map.dropped``. OpenTimelineIO is imported only when a method runs, so
the engine still starts fast.
"""

from __future__ import annotations

import math
import os
from fractions import Fraction
from typing import Any

from ..edit_schema import validate_edit_document
from ..jobs import JobContext
from ..rpc import INVALID_PARAMS, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA
from .export import METHOD as RENDER_METHOD, caption_style, export_chunks, timeline_plan

FORMATS = ["otio", "fcpxml", "fcp7xml", "edl"]
CAPTIONS = ["srt", "ass", "none"]
_CAPTION_EXTENSIONS = {"srt": "srt", "ass": "ass"}


def _checked_edit(params: dict[str, Any]) -> dict[str, Any]:
    edit = params["edit"]
    issues = validate_edit_document(edit)
    if issues:
        raise RpcError(INVALID_PARAMS, f"the edit is not valid: {issues[0].explanation}")
    return edit


def _chunks(edit: dict[str, Any], params: dict[str, Any]) -> list[Any]:
    if params.get("captions", "srt") == "none":
        return []
    canvas = edit["canvas"]
    plan = timeline_plan(edit, int(canvas["width"]), int(canvas["height"]))
    return export_chunks(edit, plan, params)


def _dropped(edit: dict[str, Any], params: dict[str, Any], chunks: list[Any]) -> list[str]:
    from .. import otio_map

    try:
        return otio_map.dropped(edit, params["format"], params.get("captions", "srt"), len(chunks), params["projectDir"])
    except otio_map.EmptyEdit as error:
        raise RpcError(INVALID_PARAMS, str(error)) from None


def _check(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    edit = _checked_edit(params)
    chunks = _chunks(edit, params)
    return {"dropped": _dropped(edit, params, chunks), "captions": len(chunks)}


def srt_ms(frame: int, rate: Fraction) -> int:
    """A frame's start in whole ms, never before it: an editor reading the SRT back at the edit's
    rate lands on the same frame."""
    return math.ceil(Fraction(frame) * 1000 / rate)


def build_srt(chunks: list[Any], rate: Fraction) -> Any:
    import pysubs2

    subs = pysubs2.SSAFile()
    for chunk in chunks:
        # pysubs2 reads `{…}` as ASS override tags and `\N` as a break; caption text stays text.
        text = chunk.text.replace("\\", "⧵").replace("{", "(").replace("}", ")")
        subs.events.append(pysubs2.SSAEvent(start=srt_ms(chunk.start, rate), end=srt_ms(chunk.end, rate), text=text))
    return subs


def timeline_text(edit: dict[str, Any], fmt: str, project_dir: str, name: str) -> str:
    """The file's contents in ``fmt``. FCPXML goes through the adapter module itself, the one
    ``fcpx_exact`` patched; the FCP7 adapter loads only as an OTIO plugin (its imports are relative)."""
    import opentimelineio as otio

    from .. import fcpx_exact, otio_map, timebase

    if fmt == "otio":
        return otio.adapters.write_to_string(otio_map.to_otio(edit, project_dir, name), "otio_json")
    timeline = otio_map.for_editor(edit, project_dir, name, fmt)
    if fmt == "fcpxml":
        return fcpx_exact.install().write_to_string(timeline)
    if fmt == "fcp7xml":
        return otio.adapters.write_to_string(timeline, "fcp_xml")
    from otio_cmx3600_adapter import cmx_3600

    return cmx_3600.write_to_string(timeline, rate=float(timebase.from_rational(edit["fps"])))


def _claim(path: str, job: JobContext) -> str:
    partial = f"{path}.part"
    if os.path.exists(path):
        raise RpcError(OUTPUT_ERROR, "an export with this name already exists")
    try:
        os.close(os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644))
    except FileExistsError:
        raise RpcError(OUTPUT_ERROR, "an export with this name is already being written") from None
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the export file cannot be created") from None
    job.track_output(partial)
    return partial


def _export(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    from .. import otio_map, timebase

    edit = _checked_edit(params)
    project_dir, base, fmt = params["projectDir"], params["outputBase"], params["format"]
    captions = params.get("captions", "srt")
    if not os.path.isabs(project_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at projectDir: must be absolute")
    if not os.path.isabs(base) or not os.path.isdir(os.path.dirname(base)):
        raise RpcError(OUTPUT_ERROR, "the exports folder does not exist")
    job.progress(0.0, "plan")
    chunks = _chunks(edit, params)
    dropped = _dropped(edit, params, chunks)
    rate = timebase.from_rational(edit["fps"])
    name = os.path.basename(base)

    outputs = [f"{base}.{otio_map.EXTENSIONS[fmt]}"]
    if chunks:
        outputs.append(f"{base}.{_CAPTION_EXTENSIONS[captions]}")
    partials = [_claim(path, job) for path in outputs]

    job.progress(0.2, "timeline")
    try:
        text = timeline_text(edit, fmt, project_dir, name)
    except ValueError as error:
        raise RpcError(INVALID_PARAMS, f"the edit cannot be written as {fmt}: {error}") from None
    with open(partials[0], "w", encoding="utf-8") as file:
        file.write(text)
    if chunks:
        job.progress(0.7, "captions")
        if captions == "ass":
            from .. import captions_ass

            canvas = edit["canvas"]
            subs = captions_ass.build_ass(chunks, rate, int(canvas["width"]), int(canvas["height"]), caption_style(edit))
        else:
            subs = build_srt(chunks, rate)
        subs.save(partials[1], format_=captions)
    job.progress(1.0, "done")
    # Past the last cancel point: every file lands, or (above) none does.
    for path in outputs:
        job.track_output(path)
    for partial, path in zip(partials, outputs):
        os.replace(partial, path)
        job.keep_output(partial)
    for path in outputs:
        job.keep_output(path)
    return {"files": outputs, "dropped": dropped, "captions": len(chunks)}


_TRANSCRIPTS = RENDER_METHOD.params_schema["properties"]["transcripts"]
_COMMON = {
    "edit": {"type": "object"},
    "projectDir": PATH_SCHEMA,
    "format": {"enum": FORMATS},
    "captions": {"enum": CAPTIONS},
    # The clips' cached transcripts (S7V-046), used only when the edit has no caption items.
    "transcripts": _TRANSCRIPTS,
}

CHECK = Method(
    "interchange.check",
    _check,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["edit", "projectDir", "format"],
        "properties": _COMMON,
    },
)

EXPORT = Method(
    "interchange.export",
    _export,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["jobId", "edit", "projectDir", "outputBase", "format"],
        "properties": {"jobId": {"type": "string"}, "outputBase": PATH_SCHEMA, **_COMMON},
    },
    job=True,
)
