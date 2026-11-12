# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Caption items from ``edit.json`` → an ASS file for libass, in one of our looks (S7V-028, S7V-037).

Chunks hold 2–4 words, split at pauses and sentence ends; a phrase of one word stays alone. Each
chunk shows from its first word's start frame up to its last word's end frame. ASS times are
centiseconds, so each frame boundary is written just before the frame starts (``frame_to_ms``):
libass then shows the chunk on its first frame and not on the frame before. The layout sits
inside the platforms' safe zone for the canvas's aspect ratio.

The looks are the JSON files in ``styles/captions/`` (the registry: a new look is a new file) and
use only the bundled fonts. A look with a ``highlight`` shows each chunk once per word, with the
word being said in that colour: one event per word state, so each starts on its word's own frame
(``\\k`` karaoke times syllables in centiseconds from the event's start and leaves past words lit).
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
#: Our looks' ids; user styles under the project's ``styles/`` folder are not read yet.
_PRESET_ID = re.compile(r"^s7-[a-z0-9-]+$")

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
    #: The chunk's words on the timeline, for a look that lights the word being said.
    words: tuple[Word, ...] = ()


@dataclass(frozen=True)
class Cue:
    """One ASS event: a chunk, or with a highlight, one word state of it (``lit`` indexes ``words``)."""

    words: tuple[str, ...]
    start: int
    end: int
    lit: int | None = None

    @property
    def text(self) -> str:
        return " ".join(self.words)


@dataclass(frozen=True)
class Layout:
    width: int
    height: int
    font_size: int
    shadow: float
    #: The outline's width, or with a box, its padding around the text, in pixels.
    edge: float
    margin_left: int
    margin_right: int
    margin_bottom: int
    #: The safe zone as (left, top, right, bottom) pixels of the canvas.
    safe: tuple[int, int, int, int]

    @property
    def safe_width(self) -> int:
        return self.safe[2] - self.safe[0]

    @property
    def text_width(self) -> int:
        """The safe width less the outline or box on both sides: where the glyphs must fit."""
        return self.safe_width - 2 * math.ceil(self.edge)


class CaptionStyleError(ValueError):
    pass


def presets() -> list[str]:
    """Our looks, by id: one JSON file each in ``styles/captions/``."""
    return sorted(path.stem for path in STYLES_DIR.glob("*.json") if _PRESET_ID.match(path.stem))


@cache
def load_style(style_id: str = DEFAULT_STYLE) -> dict[str, Any]:
    if not _PRESET_ID.match(style_id) or not (STYLES_DIR / f"{style_id}.json").is_file():
        raise CaptionStyleError(f'caption style "{style_id}" is not one of ours: {", ".join(presets())}')
    style = json.loads((STYLES_DIR / f"{style_id}.json").read_text(encoding="utf-8"))
    font = style["font"]["file"]
    if not (FONTS_DIR / font).is_file():
        # Never another font: libass would pick a system one, and the look would change.
        raise CaptionStyleError(f'caption style "{style_id}" needs the bundled font {font}, which is missing')
    return style


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
    edge = round(spec.get("pad", spec.get("outline", 0)) * short, 1)
    # The shadow falls down and to the right of the text, so those margins make room for it; an
    # outline or a box reaches out on every side.
    return Layout(
        width=width,
        height=height,
        font_size=round(spec["fontSize"] * short),
        shadow=shadow,
        edge=edge,
        margin_left=left + math.ceil(edge),
        margin_right=right + math.ceil(edge) + math.ceil(shadow),
        margin_bottom=bottom + math.ceil(edge) + math.ceil(shadow),
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
            chunks.append(Chunk(" ".join(word.text for word in group), group[0].start, group[-1].end, tuple(group)))
    return chunks


def caption_chunks(
    caption_items: list[dict[str, Any]], rate: Fraction, end_frame: int, style_id: str = DEFAULT_STYLE
) -> list[Chunk]:
    """All chunks of the given caption items, clipped to the timeline and never overlapping."""
    style = load_style(style_id)
    chunks: list[Chunk] = []
    for item in sorted(caption_items, key=lambda entry: entry["start"]):
        chunks.extend(chunk_words(_words_of(item), rate, style))
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
            words = tuple(Word(word.text, word.start, min(word.end, end)) for word in chunk.words if word.start < end)
            clipped.append(Chunk(chunk.text, chunk.start, end, words))
    return clipped


def cues(chunks: list[Chunk], style_id: str = DEFAULT_STYLE) -> list[Cue]:
    """The ASS events for ``chunks``: one per chunk, or with a highlight, one per word being said.

    A word stays lit through a pause inside its chunk, until the next word starts.
    """
    if "highlight" not in load_style(style_id):
        return [Cue((chunk.text,), chunk.start, chunk.end) for chunk in chunks]
    out: list[Cue] = []
    for chunk in chunks:
        words = chunk.words
        if not words:
            out.append(Cue((chunk.text,), chunk.start, chunk.end))
            continue
        texts = tuple(word.text for word in words)
        for index in range(len(words)):
            start = chunk.start if index == 0 else words[index].start
            end = chunk.end if index + 1 == len(words) else words[index + 1].start
            if end > start:
                out.append(Cue(texts, start, end, index))
    return out


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
    if widest <= layout.text_width:
        return size
    return max(8, math.floor(size * layout.text_width / widest))


def _colour(hex_colour: str, opacity: float = 1.0) -> pysubs2.Color:
    value = hex_colour.lstrip("#")
    alpha = round(255 * (1 - opacity))
    return pysubs2.Color(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


def _ass_colour(hex_colour: str) -> str:
    """``#RRGGBB`` as an ASS override colour, ``&HBBGGRR&``."""
    value = hex_colour.lstrip("#").upper()
    return f"&H{value[4:6]}{value[2:4]}{value[0:2]}&"


def _cue_text(cue: Cue, style: dict[str, Any]) -> str:
    if cue.lit is None:
        return _plain(cue.text)
    lit, back = _ass_colour(style["highlight"]["colour"]), _ass_colour(style["colour"]["text"])
    return " ".join(
        f"{{\\1c{lit}}}{_plain(word)}{{\\1c{back}}}" if index == cue.lit else _plain(word)
        for index, word in enumerate(cue.words)
    )


def build_ass(chunks: list[Chunk], rate: Fraction, width: int, height: int, style_id: str = DEFAULT_STYLE) -> pysubs2.SSAFile:
    return build_cues(cues(chunks, style_id), rate, width, height, style_id)


def build_cues(events: list[Cue], rate: Fraction, width: int, height: int, style_id: str = DEFAULT_STYLE) -> pysubs2.SSAFile:
    """The ASS file for ``events`` in look ``style_id``; the export and the player's stills both use it."""
    style = load_style(style_id)
    layout = layout_for(width, height, style)
    box = style.get("box")
    # With a box (border style 3), the outline colour fills the box and the outline is its padding.
    if box:
        edge_colour = _colour(box["colour"], box["opacity"])
    elif "outline" in style:
        edge_colour = _colour(style["outline"]["colour"])
    else:
        edge_colour = _colour(style["colour"]["shadow"])
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
            outlinecolor=edge_colour,
            backcolor=_colour(style["colour"]["shadow"]),
            bold=bool(style["font"]["bold"]),
            borderstyle=3 if box else 1,
            outline=layout.edge,
            shadow=layout.shadow,
            alignment=pysubs2.Alignment.BOTTOM_CENTER,
            marginl=layout.margin_left,
            marginr=layout.margin_right,
            marginv=layout.margin_bottom,
        )
    }
    for cue in events:
        text = _cue_text(cue, style)
        size = fitted_size(cue.text, layout)
        if size != layout.font_size:
            text = f"{{\\fs{size}}}{text}"
        subs.events.append(pysubs2.SSAEvent(start=frame_to_ms(cue.start, rate), end=frame_to_ms(cue.end, rate), text=text))
    return subs


def link_fonts(folder: Path) -> None:
    """Links the bundled font files (not their licence) into ``folder``, for libass's ``fontsdir``."""
    folder.mkdir()
    for font in sorted(FONTS_DIR.iterdir()):
        if font.suffix.lower() in (".ttf", ".otf"):
            (folder / font.name).symlink_to(font)


def write_ass(path: Path, chunks: list[Chunk], rate: Fraction, width: int, height: int, style_id: str = DEFAULT_STYLE) -> None:
    build_ass(chunks, rate, width, height, style_id).save(str(path), format_="ass")


def write_cues(path: Path, events: list[Cue], rate: Fraction, width: int, height: int, style_id: str = DEFAULT_STYLE) -> None:
    build_cues(events, rate, width, height, style_id).save(str(path), format_="ass")
