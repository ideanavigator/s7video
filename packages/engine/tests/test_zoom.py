# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Punch-in zoom maths (S7V-037): the crop in whole, even pixels, and the ramp's filter expressions."""

from __future__ import annotations

import math

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
    assert zoom.filters(1080, 1920, zoom.Zoom(1.0, 0.5, 0.5)) == ""
    assert zoom.filters(1080, 1920, zoom.Zoom(1.25, 0.5, 1 / 3)) == "scale=1350:2400,crop=1080:1920:136:160"


def test_ramp_reaches_scale_on_frame_n() -> None:
    ramp = zoom.Zoom(1.5, 0.5, 1 / 3, ramp_frames=6)
    assert zoom.scale_at(ramp, 0) == 1
    assert zoom.scale_at(ramp, 3) == 1.25
    # Exactly the target from frame N on, so the ramp ends on the still zoom's own rectangle.
    assert zoom.scale_at(ramp, 6) == zoom.scale_at(ramp, 60) == 1.5
    assert zoom.frame_crop(1080, 1920, ramp, 6) == zoom.crop_at(1080, 1920, 1.5, 0.5, 1 / 3)
    sizes = [zoom.frame_crop(1080, 1920, ramp, n).scaled_width for n in range(8)]
    assert sizes == sorted(sizes) and sizes[0] == 1080 and sizes[-1] == 1620


def _evaluate(expression: str, n: float) -> float:
    """An FFmpeg expression of the shape `filters` writes, evaluated as FFmpeg does (doubles)."""
    python = expression.replace("\\,", ",")
    return eval(python, {"__builtins__": {}}, {"min": min, "max": _ffmax, "floor": math.floor, "n": n})  # noqa: S307


def _ffmax(a: float, b: float) -> float:
    # FFmpeg's FFMAX(a, b) is `a > b ? a : b`: with a NaN first argument it gives the second.
    return a if a > b else b


@pytest.mark.parametrize(("scale", "frames"), [(1.25, 6), (1.15, 12), (2.0, 1), (1.37, 30)])
@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1920, 1080)])
def test_ramp_expressions_compute_the_crop_of_every_frame(width: int, height: int, scale: float, frames: int) -> None:
    ramp = zoom.Zoom(scale, 0.43, 0.29, ramp_frames=frames)
    chain = zoom.filters(width, height, ramp)
    scale_part, crop_part = chain.split(",crop=")
    options = dict(option.split("=", 1) for option in scale_part.removeprefix("scale=").split(":"))
    crop_options = dict(option.split("=", 1) for option in crop_part.split(":"))
    assert options["eval"] == "frame"
    assert (crop_options["w"], crop_options["h"]) == (str(width), str(height))
    for n in range(frames + 3):
        expected = zoom.frame_crop(width, height, ramp, n)
        got = (_evaluate(options["w"], n), _evaluate(options["h"], n), _evaluate(crop_options["x"], n), _evaluate(crop_options["y"], n))
        assert got == (expected.scaled_width, expected.scaled_height, expected.x, expected.y), n
    # At configuration FFmpeg has no frame number yet: the first size is the unzoomed canvas.
    assert (_evaluate(options["w"], math.nan), _evaluate(options["h"], math.nan)) == (width, height)
