# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Exact media time. Rates and time bases are Fractions; positions are integer frames or ticks.

Nothing here returns float seconds: the protocol carries `{num, den}` rationals and integers only.
"""

from __future__ import annotations

from fractions import Fraction


def parse_rational(text: str | None) -> Fraction | None:
    """Parses FFmpeg's `30000/1001` or `25` form; `0/0` and empty mean unknown."""
    if not text:
        return None
    num, _, den = text.partition("/")
    try:
        value = Fraction(int(num), int(den or "1"))
    except (ValueError, ZeroDivisionError):
        return None
    return value if value > 0 else None


def rational(value: Fraction) -> dict[str, int]:
    return {"num": value.numerator, "den": value.denominator}


def from_rational(value: object) -> Fraction:
    """Reads a `{num, den}` request field; raises ValueError for anything else."""
    if not isinstance(value, dict):
        raise ValueError("rate must be {num, den}")
    num, den = value.get("num"), value.get("den")
    if not isinstance(num, int) or not isinstance(den, int) or isinstance(num, bool):
        raise ValueError("rate must be {num, den} integers")
    if num <= 0 or den <= 0:
        raise ValueError("rate must be positive")
    return Fraction(num, den)


def pts_to_seconds(pts: int, time_base: Fraction) -> Fraction:
    return pts * time_base


def pts_to_frame(pts: int, time_base: Fraction, rate: Fraction, first_pts: int = 0) -> int:
    """The frame whose interval [n/rate, (n+1)/rate) holds this PTS, counted from the first frame.

    Rounds to the nearest frame start, so a PTS a tick off a boundary (container rounding) still
    lands on the frame it belongs to.
    """
    seconds = (pts - first_pts) * time_base
    return round(seconds * rate)


def seconds_to_frame(seconds: Fraction, rate: Fraction) -> int:
    """The frame nearest to an exact time, at `rate` (the same rounding as `pts_to_frame`)."""
    return round(seconds * rate)


def frame_to_seconds(frame: int, rate: Fraction) -> Fraction:
    return Fraction(frame) / rate


def frame_seek_seconds(frame: int, rate: Fraction) -> Fraction:
    """A seek point a quarter frame before frame `frame`, so rounding never lands on the frame before."""
    if frame <= 0:
        return Fraction(0)
    return (Fraction(frame) - Fraction(1, 4)) / rate


def span_frames(first_pts: int, last_pts: int, time_base: Fraction, rate: Fraction) -> int:
    """Frames from the first frame to the last one inclusive, at `rate`."""
    return pts_to_frame(last_pts, time_base, rate, first_pts) + 1


def decimal_seconds(value: Fraction) -> str:
    """FFmpeg's time syntax, exact to the microsecond; only ever passed to FFmpeg, never returned."""
    micros = round(value * 1_000_000)
    sign = "-" if micros < 0 else ""
    micros = abs(micros)
    return f"{sign}{micros // 1_000_000}.{micros % 1_000_000:06d}"
