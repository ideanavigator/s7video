# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Caption items from ``edit.json`` → an ASS file for libass, in our ``s7-neutral`` style (S7V-028).

Chunks hold 2–4 words, split at pauses and sentence ends; a phrase of one word stays alone. Each
chunk shows from its first word's start frame up to its last word's end frame. ASS times are
centiseconds, so each frame boundary is written just before the frame starts (``frame_to_ms``):
libass then shows the chunk on its first frame and not on the frame before. The layout sits
inside the platforms' safe zone for the canvas's aspect ratio.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from fractions import Fraction
from functools import cache
from pathlib import Path
from typing import Any

import pysubs2

ENGINE_ROOT = Path(__file__).resolve().parents[2]
FONTS_DIR = ENGINE_ROOT / "assets" / "fonts"
STYLES_DIR = Path(__file__).resolve().parent / "styles" / "captions"
DEFAULT_STYLE = "s7-neutral"

_SENTENCE_END = re.compile(r"[.!?…]$|[,;:]$")
# Inter Bold advances, as a share of the font size, rounded up: used only to shrink a chunk whose
# longest word cannot fit the safe width, since libass never breaks inside a word.
_WIDE = 0.74
_NARROW = 0.64
_MAX_LINES = 2


@dataclass(frozen=True)
class Word:
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class Chunk:
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class Layout:
    width: int
    height: int
    font_size: int
    shadow: float
    margin_left: int
    margin_right: int
    margin_bottom: int
    #: The safe zone as (left, top, right, bottom) pixels of the canvas.
    safe: tuple[int, int, int, int]

    @property
    def safe_width(self) -> int:
        return self.safe[2] - self.safe[0]


class CaptionStyleError(ValueError):
    pass


@cache
def load_style(style_id: str = DEFAULT_STYLE) -> dict[str, Any]:
    if style_id != DEFAULT_STYLE:
        # User styles under the project's styles/ folder come with S7V-037.
        raise CaptionStyleError(f'caption style "{style_id}" is not available yet')
    return json.loads((STYLES_DIR / f"{style_id}.json").read_text(encoding="utf-8"))


def aspect_class(width: int, height: int) -> str:
    ratio = Fraction(width, height)
    if ratio < Fraction(4, 5):
        return "portrait"
    if ratio > Fraction(5, 4):
        return "landscape"
    return "square"


def layout_for(width: int, height: int, style: dict[str, Any] | None = None) -> Layout:
    style = style or load_style()
    spec = style["layouts"][aspect_class(width, height)]
    short = min(width, height)
    safe = spec["safe"]
    left = math.ceil(safe["left"] * width)
    right = math.ceil(safe["right"] * width)
    top = math.ceil(safe["top"] * height)
    bottom = math.ceil(safe["bottom"] * height)
    shadow = round(spec["shadow"] * short, 1)
    # The shadow falls down and to the right of the text, so those margins make room for it.
    return Layout(
        width=width,
        height=height,
        font_size=round(spec["fontSize"] * short),
        shadow=shadow,
        margin_left=left,
        margin_right=right + math.ceil(shadow),
        margin_bottom=bottom + math.ceil(shadow),
        safe=(left, top, width - right, height - bottom),
    )


def _words_of(item: dict[str, Any]) -> list[Word]:
    words = [
        Word(str(word["text"]).strip(), word["start"], word["start"] + word["duration"])
        for word in item.get("words") or []
        if str(word["text"]).strip()
    ]
    if words:
        return sorted(words, key=lambda word: word.start)
    # No word timings: spread the text over the item by characters, on whole frames.
    texts = str(item.get("text", "")).split()
    if not texts:
        return []
    start, duration = item["start"], item["duration"]
    total = sum(len(text) for text in texts)
    spread: list[Word] = []
    used = 0
    for text in texts:
        begin = start + duration * used // total
        used += len(text)
        spread.append(Word(text, begin, max(begin + 1, start + duration * used // total)))
    return spread


def _balanced(phrase: list[Word], max_words: int) -> list[list[Word]]:
    count = math.ceil(len(phrase) / max_words)
    size, extra = divmod(len(phrase), count)
    groups, at = [], 0
    for index in range(count):
        step = size + (1 if index < extra else 0)
        groups.append(phrase[at : at + step])
        at += step
    return groups


def chunk_words(words: list[Word], rate: Fraction, style: dict[str, Any] | None = None) -> list[Chunk]:
    """Phrases end at a pause or punctuation; each phrase splits into balanced 2–4-word chunks."""
    rules = (style or load_style())["chunk"]
    max_words = int(rules["maxWords"])
    pause_frames = Fraction(str(rules["pauseSeconds"])) * rate
    phrases: list[list[Word]] = []
    for word in words:
        current = phrases[-1] if phrases else None
        if (
            current is None
            or word.start - current[-1].end >= pause_frames
            or _SENTENCE_END.search(current[-1].text)
        ):
            phrases.append([word])
        else:
            current.append(word)
    chunks: list[Chunk] = []
    for phrase in phrases:
        for group in _balanced(phrase, max_words):
            chunks.append(Chunk(" ".join(word.text for word in group), group[0].start, group[-1].end))
    return chunks


def caption_chunks(caption_items: list[dict[str, Any]], rate: Fraction, end_frame: int) -> list[Chunk]:
    """All chunks of the given caption items, clipped to the timeline and never overlapping."""
    chunks: list[Chunk] = []
    for item in sorted(caption_items, key=lambda entry: entry["start"]):
        chunks.extend(chunk_words(_words_of(item), rate))
    return clip_chunks(chunks, end_frame)


def clip_chunks(chunks: list[Chunk], end_frame: int) -> list[Chunk]:
    """Chunks in time order, each ending by the timeline's end and the next chunk's start."""
    chunks = sorted(chunks, key=lambda chunk: chunk.start)
    clipped: list[Chunk] = []
    for index, chunk in enumerate(chunks):
        end = min(chunk.end, end_frame)
        if index + 1 < len(chunks):
            end = min(end, chunks[index + 1].start)
        if end > chunk.start:
            clipped.append(Chunk(chunk.text, chunk.start, end))
    return clipped


def frame_to_ms(frame: int, rate: Fraction) -> int:
    """A frame boundary as whole centiseconds (in ms), at least 1 ms before the frame's start.

    FFmpeg's subtitles filter truncates ``pts * time_base * 1000`` as a double, so a frame that
    starts exactly on a 10 ms mark can reach libass 1 ms early; the margin keeps it on its frame.
    Exact below 90 fps, where a frame lasts more than 11 ms.
    """
    return max(0, math.floor((Fraction(frame) * 1000 / rate - 1) / 10) * 10)


def _plain(text: str) -> str:
    # `{` opens an override block and `\N` breaks a line in ASS; caption text must stay text.
    return text.replace("\\", "⧵").replace("{", "(").replace("}", ")")


def estimated_width(text: str, font_size: float) -> float:
    return sum((_WIDE if char.isupper() or char in "mwMW@%" else _NARROW) for char in text) * font_size


def fitted_size(text: str, layout: Layout) -> int:
    """The font size, shrunk only when the longest word or the whole chunk would leave the safe width."""
    size = layout.font_size
    longest = max((estimated_width(word, size) for word in text.split()), default=0.0)
    whole = estimated_width(text, size) / _MAX_LINES
    widest = max(longest, whole)
    if widest <= layout.safe_width:
        return size
    return max(8, math.floor(size * layout.safe_width / widest))


def _colour(hex_colour: str) -> pysubs2.Color:
    value = hex_colour.lstrip("#")
    return pysubs2.Color(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), 0)


def build_ass(chunks: list[Chunk], rate: Fraction, width: int, height: int) -> pysubs2.SSAFile:
    style = load_style()
    layout = layout_for(width, height, style)
    subs = pysubs2.SSAFile()
    subs.info["PlayResX"] = str(width)
    subs.info["PlayResY"] = str(height)
    subs.info["WrapStyle"] = "0"
    subs.info["ScaledBorderAndShadow"] = "yes"
    subs.styles = {
        "Default": pysubs2.SSAStyle(
            fontname=style["font"]["family"],
            fontsize=layout.font_size,
            primarycolor=_colour(style["colour"]["text"]),
            secondarycolor=_colour(style["colour"]["text"]),
            outlinecolor=_colour(style["colour"]["shadow"]),
            backcolor=_colour(style["colour"]["shadow"]),
            bold=bool(style["font"]["bold"]),
            borderstyle=1,
            outline=0,
            shadow=layout.shadow,
            alignment=pysubs2.Alignment.BOTTOM_CENTER,
            marginl=layout.margin_left,
            marginr=layout.margin_right,
            marginv=layout.margin_bottom,
        )
    }
    for chunk in chunks:
        text = _plain(chunk.text)
        size = fitted_size(chunk.text, layout)
        if size != layout.font_size:
            text = f"{{\\fs{size}}}{text}"
        subs.events.append(
            pysubs2.SSAEvent(start=frame_to_ms(chunk.start, rate), end=frame_to_ms(chunk.end, rate), text=text)
        )
    return subs


def link_fonts(folder: Path) -> None:
    """Links the bundled font files (not their licence) into ``folder``, for libass's ``fontsdir``."""
    folder.mkdir()
    for font in sorted(FONTS_DIR.iterdir()):
        if font.suffix.lower() in (".ttf", ".otf"):
            (folder / font.name).symlink_to(font)


def write_ass(path: Path, chunks: list[Chunk], rate: Fraction, width: int, height: int) -> None:
    build_ass(chunks, rate, width, height).save(str(path), format_="ass")
