# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

from fractions import Fraction

import pytest

from s7engine import timebase


@pytest.mark.parametrize(
    ("rate", "time_base", "ticks_per_frame"),
    [
        (Fraction(25), Fraction(1, 12800), 512),
        (Fraction(30), Fraction(1, 15360), 512),
        (Fraction(30000, 1001), Fraction(1, 30000), 1001),
        (Fraction(60), Fraction(1, 15360), 256),
        (Fraction(60), Fraction(1, 90000), 1500),
    ],
)
def test_timebase_pts_to_frames(rate: Fraction, time_base: Fraction, ticks_per_frame: int) -> None:
    for frame in (0, 1, 2, 29, 1799, 107_892):
        pts = frame * ticks_per_frame
        assert timebase.pts_to_frame(pts, time_base, rate) == frame
        # A tick of container rounding either way still names the same frame.
        assert timebase.pts_to_frame(pts + 1, time_base, rate) == frame
        assert timebase.pts_to_frame(max(0, pts - 1), time_base, rate) == frame
        assert timebase.frame_to_seconds(frame, rate) == pts * time_base


def test_first_pts_offset_and_span() -> None:
    time_base = Fraction(1, 30000)
    first = 2002
    assert timebase.pts_to_frame(first, time_base, Fraction(30000, 1001), first) == 0
    assert timebase.span_frames(first, first + 1001 * 599, time_base, Fraction(30000, 1001)) == 600


def test_seek_lands_inside_the_frame_before() -> None:
    rate = Fraction(30000, 1001)
    assert timebase.frame_seek_seconds(0, rate) == 0
    seek = timebase.frame_seek_seconds(10, rate)
    assert timebase.frame_to_seconds(9, rate) < seek < timebase.frame_to_seconds(10, rate)


def test_rationals_round_trip_and_reject_bad_input() -> None:
    assert timebase.parse_rational("30000/1001") == Fraction(30000, 1001)
    assert timebase.parse_rational("25") == Fraction(25)
    assert timebase.parse_rational("0/0") is None
    assert timebase.parse_rational("x") is None
    assert timebase.rational(Fraction(60000, 2002)) == {"num": 30000, "den": 1001}
    assert timebase.from_rational({"num": 24000, "den": 1001}) == Fraction(24000, 1001)
    for bad in ({"num": 0, "den": 1}, {"num": 1.5, "den": 1}, {"num": True, "den": 1}, [30, 1]):
        with pytest.raises(ValueError):
            timebase.from_rational(bad)


def test_decimal_seconds_is_exact_to_the_microsecond() -> None:
    assert timebase.decimal_seconds(Fraction(1001, 30000)) == "0.033367"
    assert timebase.decimal_seconds(Fraction(10)) == "10.000000"
    assert timebase.decimal_seconds(Fraction(-1, 2)) == "-0.500000"
