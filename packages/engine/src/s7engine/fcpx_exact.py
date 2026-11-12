# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Exact frame maths for the FCPXML adapter (``otio-fcpx-xml-adapter`` 1.0.0), applied at run time.

The adapter converts FCPXML times (``"1001/30000s"``) through floats and truncates with ``int()``,
and keeps rates as whole numbers, so 30000/1001 becomes 29. Spike B2 measured linked audio a frame
early on 5 of 58 clips and 7 of 58 misread source starts; true NTSC rates also miss its frame
duration table and get an empty ``frameDuration``. Its ``format_name`` runs ``ffprobe`` from PATH.

``install`` replaces those helpers (three module functions and five class attributes) with exact
``Fraction`` versions. It also stops the writer adding a browser clip to the event for every clip on
the timeline: it tests an XML element's truth, which is false for an element with no children. This file is ours and written fresh; the adapter ships unmodified. It patches
only the version it was checked against, so an upgrade fails loudly until it is checked again.
"""

from __future__ import annotations

import math
import threading
from fractions import Fraction
from importlib import metadata
from typing import Any

ADAPTER = "otio-fcpx-xml-adapter"
ADAPTER_VERSION = "1.0.0"

#: Frame durations as Final Cut Pro writes them for the common rates.
_FRAME_DURATIONS = {
    Fraction(24000, 1001): "1001/24000s",
    Fraction(24): "100/2400s",
    Fraction(25): "100/2500s",
    Fraction(30000, 1001): "1001/30000s",
    Fraction(30): "100/3000s",
    Fraction(50): "100/5000s",
    Fraction(60000, 1001): "1001/60000s",
    Fraction(60): "100/6000s",
}

_installed = False
_lock = threading.Lock()


def exact_rate(rate: Any) -> Fraction:
    """The rational rate behind an OTIO rate (a double): whole, NTSC (n×1000/1001), or nearest."""
    if isinstance(rate, Fraction):
        return rate
    value = float(rate)
    if value <= 0 or not math.isfinite(value):
        raise ValueError("a frame rate must be positive")
    whole = round(value)
    if abs(value - whole) < 1e-6:
        return Fraction(whole)
    ntsc = round(value * Fraction(1001, 1000))
    if ntsc > 0 and abs(value - ntsc * 1000 / 1001) < 0.006:
        return Fraction(ntsc * 1000, 1001)
    return Fraction(value).limit_denominator(1001)


def frames(value: float) -> int:
    """A whole frame count from an OTIO value; every time we write is a whole frame."""
    count = round(value)
    if abs(value - count) > 1e-6:
        raise ValueError("a time falls between frames")
    return count


def parse_time(text: str | None) -> Fraction:
    """An FCPXML time, ``"1001/30000s"``, ``"3s"`` or ``"0s"``, as exact seconds."""
    if not text:
        return Fraction(0)
    body = text.strip().removesuffix("s")
    num, _, den = body.partition("/")
    return Fraction(int(num), int(den or "1"))


def format_time(seconds: Fraction) -> str:
    if seconds == 0:
        return "0s"
    if seconds.denominator == 1:
        return f"{seconds.numerator}s"
    return f"{seconds.numerator}/{seconds.denominator}s"


def frame_duration(rate: Any) -> str:
    exact = exact_rate(rate)
    return _FRAME_DURATIONS.get(exact) or format_time(1 / exact)


def _rate_of_frame_duration(text: str) -> Fraction:
    return 1 / parse_time(text)


# --- Replacements ------------------------------------------------------------------------------


def to_rational_time(rational_number: str | None, fps: Any) -> Any:
    import opentimelineio as otio

    rate = exact_rate(fps)
    count = round(parse_time(rational_number) * rate)
    return otio.opentime.RationalTime(count, float(rate))


def from_rational_time(rational_time: Any) -> str:
    return format_time(frames(rational_time.value) / exact_rate(rational_time.rate))


def calculate_rational_number(duration: float, rate: Any) -> str:
    return format_time(frames(duration) / exact_rate(rate))


def format_name(frame_rate: Any, path: str) -> str:
    """No probe: the frame shape is not carried (PO, 2026-11-12), and the engine runs no PATH tools."""
    return ""


def writer_element_rate(self: Any, element: Any, default_format_id: str) -> float:
    """``FcpxOtio._frame_rate_from_element``: the rate of an element's format, exactly."""
    format_id = default_format_id
    if element.tag == "ref-clip":
        format_id = self._media_by_id(element.get("ref")).find("./sequence").get("format")
    elif element.tag == "asset-clip":
        format_id = self._asset_by_id(element.get("ref")).get("format")
    elif element.tag == "clip":
        inner = element.find("./gap/audio") if element.find("./gap") is not None else element.find("./video")
        format_id = self._asset_by_id(inner.get("ref")).get("format")
    found = self.resource_element.find(f"./format[@id='{format_id}']")
    return float(_rate_of_frame_duration(found.get("frameDuration")))


def reader_format_rate(self: Any, format_id: str) -> float:
    """``FcpxXml._format_frame_rate``."""
    return float(_rate_of_frame_duration(self._format_by_id(format_id).get("frameDuration")))


def reader_number_of_frames(self: Any, time_value: str | None, format_id: str) -> int:
    """``FcpxXml._number_of_frames``: rounds to the nearest frame instead of truncating."""
    if time_value is None:
        return 0
    rate = _rate_of_frame_duration(self._format_by_id(format_id).get("frameDuration"))
    return round(parse_time(time_value) * rate)


def _one_asset_clip(create: Any) -> Any:
    def create_once(self: Any, clip: Any, format_element: Any, resource_id: str) -> None:
        if self.event_resource.find(f"./asset-clip[@ref='{resource_id}']") is None:
            create(self, clip, format_element, resource_id)

    return create_once


def install() -> Any:
    """Patches the adapter once and returns its module. Refuses any version but the checked one."""
    global _installed
    found = metadata.version(ADAPTER)
    if found != ADAPTER_VERSION:
        raise RuntimeError(f"{ADAPTER} {found} is not the checked {ADAPTER_VERSION}; re-check fcpx_exact")
    from otio_fcpx_xml_adapter import fcpx_xml

    with _lock:
        if not _installed:
            fcpx_xml.to_rational_time = to_rational_time
            fcpx_xml.from_rational_time = from_rational_time
            fcpx_xml.format_name = format_name
            fcpx_xml.FcpxOtio._frame_rate_from_element = writer_element_rate
            fcpx_xml.FcpxOtio._framerate_to_frame_duration = staticmethod(frame_duration)
            fcpx_xml.FcpxOtio._calculate_rational_number = staticmethod(calculate_rational_number)
            fcpx_xml.FcpxXml._format_frame_rate = reader_format_rate
            fcpx_xml.FcpxXml._number_of_frames = reader_number_of_frames
            writer = fcpx_xml.FcpxOtio
            writer._create_asset_clip_element = _one_asset_clip(writer._create_asset_clip_element)
            _installed = True
    return fcpx_xml
