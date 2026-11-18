# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Punch-in zoom maths (S7V-037): the crop in whole, even pixels, and a ramp's still-zoom parts."""

from __future__ import annotations


import pytest

from s7engine import zoom


def test_crop_rect_centre_scale_2() -> None:
    # 1080×1920 at 2.0, fixed at the middle of the upper third: the eye line stays where it is.
    crop = zoom.crop_at(1080, 1920, 2.0, 0.5, 0.33)
    assert crop == zoom.Crop(scaled_width=2160, scaled_height=3840, x=540, y=634)
    # The fixed point maps to itself: 0.33 of the frame before and after (within the even rounding).
    assert abs((0.33 * crop.scaled_height - crop.y) - 0.33 * 1920) <= 2


@pytest.mark.parametrize("scale", [1.0, 1.15, 1.25, 1.5, 1.99, 2.0])
@pytest.mark.parametrize(("anchor_x", "anchor_y"), [(0, 0), (1, 1), (0.5, 1 / 3), (0.37, 0.71), (0.999, 0.001)])
@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1080, 1080), (1920, 1080), (720, 1280)])
def test_crop_rect_is_even_and_clamped(width: int, height: int, scale: float, anchor_x: float, anchor_y: float) -> None:
    crop = zoom.crop_at(width, height, scale, anchor_x, anchor_y)
    assert crop.scaled_width % 2 == crop.scaled_height % 2 == crop.x % 2 == crop.y % 2 == 0
    assert 0 <= crop.x <= crop.scaled_width - width and 0 <= crop.y <= crop.scaled_height - height
    assert abs(crop.scaled_width - width * scale) <= 1 and abs(crop.scaled_height - height * scale) <= 1
    if anchor_x == 0:
        assert crop.x == 0
    if anchor_x == 1:
        assert crop.x == crop.scaled_width - width


def test_no_zoom_and_scale_one_draw_nothing() -> None:
    assert zoom.Zoom.from_edit(None) is None
    assert zoom.Zoom.from_edit({"scale": 1, "anchorX": 0.5, "anchorY": 0.5, "rampFrames": 0}) is None
    assert zoom.filters(1080, 1920, 1.0, 0.5, 0.5) == ""
    assert zoom.filters(1080, 1920, 1.25, 0.5, 1 / 3) == "scale=1350:2400,crop=1080:1920:136:160"


def test_ramp_reaches_scale_on_frame_n() -> None:
    ramp = zoom.Zoom(1.5, 0.5, 1 / 3, ramp_frames=6)
    assert zoom.scale_at(ramp, 0) == 1
    assert zoom.scale_at(ramp, 3) == 1.25
    # Exactly the target from frame N on, so the ramp ends on the still zoom's own rectangle.
    assert zoom.scale_at(ramp, 6) == zoom.scale_at(ramp, 60) == 1.5
    assert zoom.frame_crop(1080, 1920, ramp, 6) == zoom.crop_at(1080, 1920, 1.5, 0.5, 1 / 3)
    sizes = [zoom.frame_crop(1080, 1920, ramp, n).scaled_width for n in range(8)]
    assert sizes == sorted(sizes) and sizes[0] == 1080 and sizes[-1] == 1620


def test_ramp_parts_are_one_still_zoom_per_ramp_frame_then_the_target() -> None:
    ramp = zoom.Zoom(1.5, 0.5, 1 / 3, ramp_frames=6)
    parts = zoom.ramp_parts(ramp, 40)
    assert [(part.start, part.end) for part in parts] == [(n, n + 1) for n in range(6)] + [(6, 40)]
    assert [part.scale for part in parts] == [zoom.scale_at(ramp, n) for n in range(6)] + [1.5]
    assert parts[0].scale == 1 and parts[-1].scale == 1.5
    # An item shorter than the ramp is all ramp; a still zoom is one part.
    assert [(part.start, part.end) for part in zoom.ramp_parts(ramp, 4)] == [(0, 1), (1, 2), (2, 3), (3, 4)]
    assert zoom.ramp_parts(zoom.Zoom(1.25, 0.5, 0.5), 30) == [zoom.Part(0, 30, 1.25)]
