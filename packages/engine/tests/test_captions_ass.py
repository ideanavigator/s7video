# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Our caption looks (S7V-037): the registry, their fonts, layouts and the word-by-word highlight."""

from __future__ import annotations

import math
from fractions import Fraction
from pathlib import Path

import pysubs2
import pytest

from s7engine import captions_ass

PRESETS = ["s7-box", "s7-karaoke", "s7-minimal", "s7-neutral"]
CANVASES = [(1080, 1920), (1080, 1080), (1920, 1080), (720, 1280)]


@pytest.fixture
def fresh_styles():
    captions_ass.load_style.cache_clear()
    yield
    captions_ass.load_style.cache_clear()


def test_presets_load_and_unknown_refused(fresh_styles: None) -> None:
    assert captions_ass.presets() == PRESETS
    for preset in PRESETS:
        style = captions_ass.load_style(preset)
        assert style["id"] == preset
        assert set(style["layouts"]) == {"portrait", "square", "landscape"}
    for bad in ["kigaru", "s7-nope", "../s7-neutral", "s7-neutral/../x", "S7-NEUTRAL", ""]:
        with pytest.raises(captions_ass.CaptionStyleError, match="is not one of ours"):
            captions_ass.load_style(bad)


def test_every_preset_uses_only_bundled_ofl_fonts() -> None:
    licence = (captions_ass.FONTS_DIR / "OFL.txt").read_text(encoding="utf-8")
    assert "SIL Open Font License, Version 1.1" in licence
    for preset in PRESETS:
        font = captions_ass.load_style(preset)["font"]
        assert (captions_ass.FONTS_DIR / font["file"]).is_file()
        assert (font["file"], font["family"]) == ("Inter-Bold.ttf", "Inter")


def test_missing_font_fails_clearly(fresh_styles: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(captions_ass, "FONTS_DIR", tmp_path)
    with pytest.raises(captions_ass.CaptionStyleError, match="needs the bundled font Inter-Bold.ttf, which is missing"):
        captions_ass.load_style("s7-box")


def _words(*spec: tuple[str, int, int]) -> list[captions_ass.Word]:
    return [captions_ass.Word(text, start, end) for text, start, end in spec]


def test_karaoke_word_states_on_word_frames() -> None:
    rate = Fraction(30)
    words = _words(("Say", 30, 40), ("it", 44, 50), ("loud.", 50, 75))
    [chunk] = captions_ass.chunk_words(words, rate, captions_ass.load_style("s7-karaoke"))
    cues = captions_ass.cues([chunk], "s7-karaoke")
    # One state per word: each starts on its word's first frame and lasts until the next word
    # starts, through the pause after "Say"; the last ends with the chunk.
    assert [(cue.start, cue.end, cue.lit) for cue in cues] == [(30, 44, 0), (44, 50, 1), (50, 75, 2)]
    assert all(cue.text == "Say it loud." for cue in cues)
    subs = captions_ass.build_cues(cues, rate, 1080, 1920, "s7-karaoke")
    lit = "{\\1c&H4DE1FF&}"
    back = "{\\1c&HFFFFFF&}"
    assert [event.text for event in subs.events] == [
        f"{lit}Say{back} it loud.",
        f"Say {lit}it{back} loud.",
        f"Say it {lit}loud.{back}",
    ]
    # Each state switches on the frame its word starts, as every chunk does (frame_to_ms).
    assert [event.start for event in subs.events] == [captions_ass.frame_to_ms(f, rate) for f in (30, 44, 50)]
    assert [event.end for event in subs.events] == [captions_ass.frame_to_ms(f, rate) for f in (44, 50, 75)]


def test_colours_are_plain_rgb_on_any_video(tmp_path: Path) -> None:
    # S7V-016: without "YCbCr Matrix: None", FFmpeg 9 and libass 0.17.5 shift caption colours on
    # YUV video as VSFilter did, so the export no longer matched the player's still.
    words = _words(("one", 0, 5), ("two", 6, 11))
    [chunk] = captions_ass.chunk_words(words, Fraction(30), captions_ass.load_style("s7-neutral"))
    path = tmp_path / "captions.ass"
    captions_ass.write_cues(path, captions_ass.cues([chunk], "s7-neutral"), Fraction(30), 1080, 1920, "s7-neutral")
    assert "YCbCr Matrix: None" in path.read_text(encoding="utf-8").splitlines()


def test_looks_without_a_highlight_keep_one_event_per_chunk() -> None:
    words = _words(("one", 0, 5), ("two", 6, 11), ("three", 12, 17))
    for preset in ["s7-neutral", "s7-box", "s7-minimal"]:
        chunks = captions_ass.chunk_words(words, Fraction(30), captions_ass.load_style(preset))
        assert [(cue.text, cue.start, cue.end, cue.lit) for cue in captions_ass.cues(chunks, preset)] == [("one two three", 0, 17, None)]


def test_a_highlighted_word_cannot_inject_ass_tags() -> None:
    chunk = captions_ass.Chunk("{\\pos(0,0)} hi", 0, 20, tuple(_words(("{\\pos(0,0)}", 0, 10), ("hi", 10, 20))))
    for event in captions_ass.build_ass([chunk], Fraction(30), 1080, 1920, "s7-karaoke").events:
        assert "\\pos" not in event.text and "(" in event.text


def test_clipped_chunks_keep_their_words_inside() -> None:
    chunks = captions_ass.clip_chunks([captions_ass.Chunk("a b c", 0, 30, tuple(_words(("a", 0, 10), ("b", 10, 20), ("c", 20, 30))))], 15)
    assert chunks == [captions_ass.Chunk("a b c", 0, 15, tuple(_words(("a", 0, 10), ("b", 10, 15))))]


@pytest.mark.parametrize("preset", PRESETS)
@pytest.mark.parametrize(("width", "height"), CANVASES)
def test_layout_inside_safe_zone_for_every_preset(preset: str, width: int, height: int) -> None:
    style = captions_ass.load_style(preset)
    layout = captions_ass.layout_for(width, height, style)
    left, top, right, bottom = layout.safe
    # An outline or box reaches its width plus an anti-aliased pixel past the text.
    edge = math.ceil(layout.edge) + (1 if layout.edge > 0 else 0)
    shadow = math.ceil(layout.shadow)
    assert layout.edge_pixels == edge
    # The text box, its outline or box padding, its shadow and a pixel of slack each side all stay
    # inside the safe zone.
    assert layout.margin_left == left + edge + 1
    assert width - layout.margin_right + edge + shadow + 1 == right
    assert height - layout.margin_bottom + edge + shadow == bottom
    assert layout.text_width == layout.safe_width - 2 * (edge + 1)
    assert bottom - 2.5 * layout.font_size - 2 * edge - shadow > top
    ass = captions_ass.build_ass([captions_ass.Chunk("hello there", 0, 30)], Fraction(30), width, height, preset)
    ass_style = ass.styles["Default"]
    assert (ass_style.fontname, ass_style.bold) == ("Inter", True)
    if preset == "s7-box":
        assert (ass_style.borderstyle, ass_style.shadow) == (3, 0)
        assert ass_style.outline == layout.edge > 0
        assert ass_style.outlinecolor.a == round(255 * (1 - 0.72))
    elif preset == "s7-minimal":
        assert (ass_style.borderstyle, ass_style.shadow) == (1, 0)
        assert 0 < ass_style.outline == layout.edge < 4
        assert layout.font_size < captions_ass.layout_for(width, height).font_size
    else:
        assert (ass_style.borderstyle, ass_style.outline) == (1, 0) and ass_style.shadow > 0


@pytest.mark.parametrize("preset", PRESETS)
@pytest.mark.parametrize(("width", "height"), CANVASES)
def test_long_words_shrink_to_fit_the_safe_width(preset: str, width: int, height: int) -> None:
    layout = captions_ass.layout_for(width, height, captions_ass.load_style(preset))
    text = "Supercalifragilistic Extraordinarily Wikipedia's Arbitration"
    size = captions_ass.fitted_size(text, layout)
    assert size <= layout.font_size
    if height > width:
        assert size < layout.font_size, "a 9:16 canvas must shrink these words"
    assert max(captions_ass.estimated_width(word, size) for word in text.split()) <= layout.text_width
    assert captions_ass.estimated_width(text, size) / 2 <= layout.text_width


# --- S7V-099: a caption track's own colours, size and place -------------------------------------


def test_custom_colours_size_and_place_on_any_look() -> None:
    chunk = [captions_ass.Chunk("hello there", 0, 30)]
    custom = {"textColor": "#FF8800", "size": 1.4, "position": "top"}
    plain = captions_ass.build_ass(chunk, Fraction(30), 1080, 1920, "s7-neutral").styles["Default"]
    ass = captions_ass.build_ass(chunk, Fraction(30), 1080, 1920, "s7-neutral", custom).styles["Default"]
    layout = captions_ass.layout_for(1080, 1920, captions_ass.styled("s7-neutral", custom))
    assert (ass.primarycolor.r, ass.primarycolor.g, ass.primarycolor.b) == (0xFF, 0x88, 0x00)
    assert ass.fontsize == round(1.4 * captions_ass.load_style("s7-neutral")["layouts"]["portrait"]["fontSize"] * 1080)
    assert ass.fontsize > plain.fontsize and ass.shadow > plain.shadow
    assert (ass.alignment, ass.marginv) == (pysubs2.Alignment.TOP_CENTER, layout.margin_top)
    assert layout.margin_top == layout.safe[1] + layout.edge_pixels
    middle = captions_ass.build_ass(chunk, Fraction(30), 1080, 1920, "s7-neutral", {"position": "middle"})
    assert middle.styles["Default"].alignment == pysubs2.Alignment.MIDDLE_CENTER
    # The cached look is never changed by a track's custom.
    assert captions_ass.load_style("s7-neutral")["colour"]["text"] == "#FFFFFF"
    assert captions_ass.styled("s7-neutral") is captions_ass.load_style("s7-neutral")


def test_custom_box_colour_is_solid() -> None:
    chunk = [captions_ass.Chunk("hello there", 0, 30)]
    ass = captions_ass.build_ass(chunk, Fraction(30), 1920, 1080, "s7-box", {"boxColor": "#1E3A8A", "size": 1.4})
    box = ass.styles["Default"]
    assert (box.outlinecolor.r, box.outlinecolor.g, box.outlinecolor.b) == (0x1E, 0x3A, 0x8A)
    # Solid, so the boxes of a two-line caption don't show a seam where they overlap.
    assert box.outlinecolor.a == 0
    # Padding grows with the text.
    plain = captions_ass.layout_for(1920, 1080, captions_ass.load_style("s7-box"))
    assert box.outline == pytest.approx(round(plain.edge * 1.4, 1), abs=0.11)
    # A colour for a part the look doesn't have changes nothing.
    neutral = captions_ass.build_ass(chunk, Fraction(30), 1920, 1080, "s7-neutral", {"boxColor": "#1E3A8A"})
    assert neutral.styles["Default"] == captions_ass.build_ass(chunk, Fraction(30), 1920, 1080, "s7-neutral").styles["Default"]


def test_custom_highlight_colour_lights_the_spoken_word() -> None:
    words = _words(("Say", 0, 8), ("it", 10, 15), ("loud", 15, 25))
    cues = captions_ass.cues([captions_ass.Chunk("Say it loud", 0, 25, tuple(words))], "s7-karaoke")
    custom = {"highlightColor": "#00C2FF", "textColor": "#FFEEDD"}
    ass = captions_ass.build_cues(cues, Fraction(30), 1080, 1920, "s7-karaoke", custom)
    # ASS colours are blue, green, red.
    assert ass.events[1].text == "Say {\\1c&HFFC200&}it{\\1c&HDDEEFF&} loud"


@pytest.mark.parametrize("preset", PRESETS)
@pytest.mark.parametrize("size", [0.6, 1.6])
def test_custom_sizes_still_fit_the_safe_width(preset: str, size: float) -> None:
    layout = captions_ass.layout_for(1080, 1920, captions_ass.styled(preset, {"size": size}))
    text = "Supercalifragilistic Extraordinarily"
    fitted = captions_ass.fitted_size(text, layout)
    assert max(captions_ass.estimated_width(word, fitted) for word in text.split()) <= layout.text_width
    assert layout.margin_top >= layout.safe[1] and layout.margin_bottom >= 1920 - layout.safe[3]
