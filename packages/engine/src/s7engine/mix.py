# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Sound effects and music in the export's mix (S7V-036). Pure: numbers in, filter text out.

Each sound or music item gets one chain over its own input: the file from ``in`` as 48 kHz stereo
float (one resample), its gain and fades, delayed to its exact first sample on the timeline and
padded to the edit's length. The voice and every chain are summed by ``amix`` with
``normalize=0``, so nothing is rescaled before the export's one loudness gain.

A music track's ``duck`` is one ``volume`` envelope, evaluated once per 64-sample frame: at FFmpeg's
default 1,024 samples each step leaves zipper noise; at 64 it is at the noise floor (S7V-036
Check 2). Per speech range the level goes down to ``depthDb`` over ``attackFrames`` before the range
starts, holds through it, and comes back over ``releaseFrames`` after it ends. Where two curves
overlap the deeper one wins, so a short pause stays partly ducked. No compressor, no sidechain.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

SAMPLE_RATE = 48_000
DUCK_FRAME_SAMPLES = 64
#: A ramp of zero frames is drawn over one sample, so the envelope stays continuous.
_SHORTEST_RAMP = Fraction(1, SAMPLE_RATE)
#: An item the video's end cuts short, with no fade-out of its own, fades over this so it never
#: clicks: the same 10 ms as the export's joins.
CUT_FADE_SECONDS = Fraction(1, 100)


def sample_at(frame: int, rate: Fraction) -> int:
    """The audio sample where timeline frame ``frame`` starts; cumulative, so it never drifts."""
    return round(Fraction(frame) * SAMPLE_RATE / rate)


@dataclass(frozen=True)
class Duck:
    depth_db: float
    attack_frames: int
    release_frames: int
    #: Sorted and merged timeline ranges ``(start, end)``, end exclusive.
    ranges: tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class AudioItem:
    media: str
    start: int
    #: Frames that play: the item's duration, trimmed at the end of the video.
    frames: int
    source_in: int
    gain_db: float = 0.0
    fade_in: int = 0
    fade_out: int = 0
    duck: Duck | None = None
    #: The video's end cut the item short.
    cut_short: bool = False


def _merged(ranges: list[dict[str, Any]]) -> tuple[tuple[int, int], ...]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted((int(entry["start"]), int(entry["end"])) for entry in ranges if entry["end"] > entry["start"]):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return tuple(merged)


def duck_of(track: dict[str, Any]) -> Duck | None:
    duck = track.get("duck")
    if duck is None or float(duck["depthDb"]) >= 0:
        return None
    ranges = _merged(duck["ranges"])
    if not ranges:
        return None
    return Duck(float(duck["depthDb"]), int(duck["attackFrames"]), int(duck["releaseFrames"]), ranges)


def audio_items(edit: dict[str, Any], total_frames: int) -> list[AudioItem]:
    """The sound effect and music items that play, trimmed at the end of the video.

    An item cut short there fades out at that end: over its own fade-out, or over 10 ms
    (``CUT_FADE_SECONDS``) when it has none. Cut short means the video's end stops it before its
    file ends, whether the export trims it or it was placed already ending there.
    """
    media = {entry["id"]: entry for entry in edit["media"]}
    items: list[AudioItem] = []
    for track in edit["tracks"]:
        if track["kind"] not in ("sfx", "music") or track.get("muted"):
            continue
        duck = duck_of(track) if track["kind"] == "music" else None
        for item in sorted(track["items"], key=lambda entry: entry["start"]):
            frames = min(int(item["duration"]), total_frames - int(item["start"]))
            if frames <= 0:
                continue
            fade_in = min(int(item.get("fadeInFrames", 0)), frames)
            fade_out = min(int(item.get("fadeOutFrames", 0)), frames - fade_in)
            # A file of unknown length counts as going on: a 10 ms fade is safe either way.
            length = ((media.get(item["media"]) or {}).get("probe") or {}).get("durationFrames")
            file_goes_on = length is None or int(item.get("in", 0)) + frames < int(length)
            at_video_end = int(item["start"]) + frames == total_frames
            items.append(
                AudioItem(
                    media=item["media"],
                    start=int(item["start"]),
                    frames=frames,
                    source_in=int(item.get("in", 0)),
                    gain_db=float(item.get("gainDb", 0.0)),
                    fade_in=fade_in,
                    fade_out=fade_out,
                    duck=duck,
                    cut_short=frames < int(item["duration"]) or (at_video_end and file_goes_on),
                )
            )
    return items


# --- The duck envelope -------------------------------------------------------------------------


Piece = tuple[Fraction, Fraction, Fraction, Fraction]


def duck_pieces(duck: Duck, rate: Fraction, total_frames: int) -> list[Piece]:
    """The duck as linear pieces ``(t0, t1, v0, v1)`` over ``[0, end]`` in seconds; ``v`` is the
    share of ``depth_db`` (0 none, 1 full). Every corner of the curve is a piece boundary."""
    end = Fraction(total_frames) / rate
    attack = max(Fraction(duck.attack_frames) / rate, _SHORTEST_RAMP)
    release = max(Fraction(duck.release_frames) / rate, _SHORTEST_RAMP)
    spans = [(Fraction(start) / rate, Fraction(stop) / rate) for start, stop in duck.ranges]
    starts = [start for start, _ in spans]

    def depth(t: Fraction) -> Fraction:
        # Ranges are sorted and apart, so only the last one begun and the next one count.
        index = bisect.bisect_right(starts, t) - 1
        if index >= 0 and t <= spans[index][1]:
            return Fraction(1)
        after = 1 - (t - spans[index][1]) / release if index >= 0 else Fraction(0)
        before = 1 - (spans[index + 1][0] - t) / attack if index + 1 < len(spans) else Fraction(0)
        return max(Fraction(0), after, before)

    corners = {Fraction(0), end}
    for index, (start, stop) in enumerate(spans):
        corners.update((start - attack, start, stop, stop + release))
        if index + 1 < len(spans):
            following = spans[index + 1][0]
            corners.add((attack * stop + release * following) / (attack + release))
    times = sorted(t for t in corners if 0 <= t <= end)
    pieces: list[Piece] = []
    for t0, t1 in zip(times, times[1:]):
        v0, v1 = depth(t0), depth(t1)
        if pieces and pieces[-1][2] == pieces[-1][3] == v0 == v1:
            pieces[-1] = (pieces[-1][0], t1, v0, v1)
        else:
            pieces.append((t0, t1, v0, v1))
    return pieces


def _number(value: Fraction | float) -> str:
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _leaf(piece: Piece) -> str:
    t0, t1, v0, v1 = piece
    if v0 == v1:
        return _number(v0)
    slope = (v1 - v0) / (t1 - t0)
    sign = "-" if slope < 0 else "+"
    return f"({_number(v0)}{sign}{_number(abs(slope))}*(t-{_number(t0)}))"


def _tree(pieces: list[Piece]) -> str:
    # FFmpeg evaluates only the taken branch of if(), so each frame costs log2(pieces) tests.
    if len(pieces) == 1:
        return _leaf(pieces[0])
    middle = len(pieces) // 2
    return f"if(lt(t,{_number(pieces[middle][0])}),{_tree(pieces[:middle])},{_tree(pieces[middle:])})"


def duck_expression(duck: Duck, rate: Fraction, total_frames: int) -> str:
    """The ``volume`` expression (linear gain) for ``t`` in timeline seconds."""
    return f"pow(10,{_number(duck.depth_db)}*{_tree(duck_pieces(duck, rate, total_frames))}/20)"


# --- Chains ------------------------------------------------------------------------------------


def read_seconds(item: AudioItem, rate: Fraction) -> Fraction:
    """How much of the file to read: one second past the last sample the item plays."""
    return Fraction(item.source_in + item.frames) / rate + 1


def item_chain(item: AudioItem, input_index: int, rate: Fraction, total_frames: int, label: str) -> str:
    first = sample_at(item.start, rate)
    samples = sample_at(item.start + item.frames, rate) - first
    source = sample_at(item.source_in, rate)
    total = sample_at(total_frames, rate)
    steps = [
        "asetpts=PTS-STARTPTS",
        f"aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo",
        f"atrim=start_sample={source}:end_sample={source + samples}",
        "asetpts=PTS-STARTPTS",
        f"apad=whole_len={samples}",
    ]
    if abs(item.gain_db) >= 0.005:
        steps.append(f"volume={item.gain_db:.2f}dB")
    if item.fade_in:
        steps.append(f"afade=t=in:ns={sample_at(item.start + item.fade_in, rate) - first}")
    if item.fade_out:
        length = first + samples - sample_at(item.start + item.frames - item.fade_out, rate)
        steps.append(f"afade=t=out:ss={samples - length}:ns={length}")
    elif item.cut_short:
        length = min(round(CUT_FADE_SECONDS * SAMPLE_RATE), samples // 2)
        steps.append(f"afade=t=out:ss={samples - length}:ns={length}")
    if first:
        steps.append(f"adelay=delays={first}S|{first}S")
    steps.append(f"apad=whole_len={total},atrim=end_sample={total}")
    if item.duck is not None:
        steps += [
            "asetpts=N/SR/TB",
            f"asetnsamples=n={DUCK_FRAME_SAMPLES}:p=0",
            f"volume='{duck_expression(item.duck, rate, total_frames)}':eval=frame",
        ]
    return f"[{input_index}:a:0]{','.join(steps)}[{label}]"


def mix_chains(items: list[AudioItem], first_input: int, rate: Fraction, total_frames: int) -> list[str]:
    """The chains that sum ``[voice]`` and every item into ``[amix]``."""
    chains = [item_chain(item, first_input + index, rate, total_frames, f"x{index}") for index, item in enumerate(items)]
    labels = "".join(f"[x{index}]" for index in range(len(items)))
    chains.append(f"[voice]{labels}amix=inputs={len(items) + 1}:normalize=0:duration=first[amix]")
    return chains
