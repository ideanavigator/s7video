# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Punch-in zoom for the export (S7V-037): pure, in whole pixels.

A zoom scales the canvas-sized frame up by ``scale`` and crops the canvas back out of it. The
anchor is the zoom's fixed point: the pixel at (``anchor_x``, ``anchor_y``) of the frame stays
where it is while the picture grows around it, as CSS ``transform-origin`` does, so the player can
draw the same zoom later (S7V-092). Sizes and offsets are even, for 4:2:0 chroma, and the crop
never leaves the frame. With ``ramp_frames`` N the scale grows linearly from 1 on the item's first
frame to ``scale`` on frame N: each ramp frame is drawn with its own still zoom (``ramp_parts``).
FFmpeg's ``scale`` can change the frame size per frame (``eval=frame``), but ``crop`` keeps placing
its rectangle by the first frame's size, so a moving size can't be cut out exactly (S7V-037 Check 2).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Zoom:
    scale: float
    anchor_x: float
    anchor_y: float
    ramp_frames: int = 0

    @classmethod
    def from_edit(cls, value: dict[str, Any] | None) -> Zoom | None:
        """An item's ``zoom`` from ``edit.json``; none when missing or a scale of 1."""
        if value is None or float(value["scale"]) == 1:
            return None
        return cls(float(value["scale"]), float(value["anchorX"]), float(value["anchorY"]), int(value["rampFrames"]))


@dataclass(frozen=True)
class Crop:
    """Scale the frame to ``scaled_width`` × ``scaled_height``, then cut the canvas out at (x, y)."""

    scaled_width: int
    scaled_height: int
    x: int
    y: int


def _even(value: float) -> int:
    """The nearest even integer, halves up: ``2*floor(v/2+0.5)``."""
    return 2 * math.floor(value / 2 + 0.5)


def crop_at(width: int, height: int, scale: float, anchor_x: float, anchor_y: float) -> Crop:
    scaled_width = max(width, _even(width * scale))
    scaled_height = max(height, _even(height * scale))
    x = min(max(0, _even(anchor_x * (scaled_width - width))), scaled_width - width)
    y = min(max(0, _even(anchor_y * (scaled_height - height))), scaled_height - height)
    return Crop(scaled_width, scaled_height, x, y)


def scale_at(zoom: Zoom, frame: int) -> float:
    """The scale on frame ``frame`` of the item (0 is its first): the target from ``ramp_frames`` on."""
    if zoom.ramp_frames <= 0:
        return zoom.scale
    return 1 + (zoom.scale - 1) * (min(max(frame, 0), zoom.ramp_frames) / zoom.ramp_frames)


def frame_crop(width: int, height: int, zoom: Zoom, frame: int) -> Crop:
    return crop_at(width, height, scale_at(zoom, frame), zoom.anchor_x, zoom.anchor_y)


def filters(width: int, height: int, scale: float, anchor_x: float, anchor_y: float) -> str:
    """The filter chain for a still zoom of a ``width`` × ``height`` frame; empty when nothing changes."""
    crop = crop_at(width, height, scale, anchor_x, anchor_y)
    if (crop.scaled_width, crop.scaled_height) == (width, height):
        return ""
    return f"scale={crop.scaled_width}:{crop.scaled_height},crop={width}:{height}:{crop.x}:{crop.y}"


@dataclass(frozen=True)
class Part:
    """Frames ``start`` to ``end`` (end exclusive, counted from the item's first) at one still scale."""

    start: int
    end: int
    scale: float


def ramp_parts(zoom: Zoom, frames: int) -> list[Part]:
    """An item of ``frames`` frames as still-zoom parts: one per ramp frame, then the target to its end."""
    ramp = min(max(zoom.ramp_frames, 0), frames)
    parts = [Part(step, step + 1, scale_at(zoom, step)) for step in range(ramp)]
    if frames > ramp:
        parts.append(Part(ramp, frames, zoom.scale))
    return parts
