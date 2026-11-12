# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`captions.render` (S7V-075): the player's caption stills are the export's chunks, drawn by libass."""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import subprocess
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from engine_support import FFMPEG, Wire
from export_support import make_edit

from s7engine import captions_ass, captions_from_words
from s7engine.jobs import JobContext
from s7engine.rpc import MEDIA_ERROR, RpcError
from s7engine.methods import captions, export

W, H = 288, 512


def _edit(tmp_path: Path, ranges: list[tuple[int, int]], items: list[dict[str, Any]], rate: Fraction = Fraction(30)) -> dict[str, Any]:
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"")
    return make_edit(source=source, ranges=ranges, fps=rate, duration_frames=10_000, width=W, height=H, captions=items)


def _transcript(words: list[tuple[str, int, int]]) -> dict[str, Any]:
    return {"media": "cam", "fps": {"num": 30, "den": 1}, "words": [{"text": t, "startFrame": s, "endFrame": e} for t, s, e in words]}


def _track_items(plan: export.Plan, transcript: dict[str, Any]) -> list[dict[str, Any]]:
    """The caption items "add captions" writes: one per uncut run, words in timeline frames."""
    items = []
    for index, group in enumerate(captions_from_words.map_words(plan.segments, {"cam": transcript}, plan.rate)):
        start, end = group[0].start, max(word.end for word in group)
        items.append(
            {
                "id": f"c{index + 1}",
                "start": start,
                "duration": end - start,
                "text": " ".join(word.text for word in group),
                "words": [{"text": word.text, "start": word.start, "duration": word.end - word.start} for word in group],
            }
        )
    return items


SPOKEN = [("So", 0, 5), ("today", 6, 11), ("we", 12, 17), ("cut", 18, 23), ("the", 24, 29), ("silences.", 30, 35),
          ("Then", 66, 71), ("across", 85, 125), ("we", 130, 135), ("add", 136, 141), ("captions", 142, 147)]


def test_render_chunks_equal_the_export_chunks(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 40), (60, 90), (120, 160)], [])
    plan = export.plan_segments(edit, W, H)
    transcript = _transcript(SPOKEN)
    fallback = export.export_chunks(edit, plan, {"transcripts": [transcript]})
    edit["tracks"][1]["items"] = _track_items(plan, transcript)
    # The track has one item per uncut run, so its chunks are the transcript fallback's (AC-7).
    assert export.export_chunks(edit, plan, {}) == fallback
    assert captions.chunks_of(edit) == fallback
    assert [c.text for c in fallback][:2] == ["So today we", "cut the silences."]


def test_muted_caption_track_gives_no_chunks(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 90)], [{"id": "c1", "start": 0, "duration": 20, "text": "hello there"}])
    assert len(captions.chunks_of(edit)) == 1
    edit["tracks"][1]["muted"] = True
    assert captions.chunks_of(edit) == []


def test_chunks_end_with_the_timeline(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 30)], [{"id": "c1", "start": 20, "duration": 40, "text": "past the end"}])
    assert [(c.start, c.end) for c in captions.chunks_of(edit)] == [(20, 30)]


def _render(edit: dict[str, Any], cache: Path, transcripts: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"edit": edit, "cacheDir": str(cache)}
    if transcripts is not None:
        params["transcripts"] = transcripts
    return captions._render(params, JobContext.detached())


def test_no_captions_writes_no_stills(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 30)], [])
    result = _render(edit, tmp_path / "cache")
    assert (result["chunks"], result["drawn"]) == ([], 0)


def _png_size_and_mode(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width, height, _depth, colour = struct.unpack(">IIBB", data[16:26])
    return width, height, colour


def _alpha(path: Path) -> bytes:
    assert FFMPEG is not None
    return subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-vf", "format=rgba,alphaextract,format=gray", "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout


@pytest.mark.usefixtures("tools")
def test_render_draws_one_transparent_still_per_text(tmp_path: Path) -> None:
    items = [
        {"id": "c1", "start": 0, "duration": 20, "text": "hello there"},
        {"id": "c2", "start": 30, "duration": 20, "text": "hello there"},
        {"id": "c3", "start": 60, "duration": 20, "text": "{\\b0}plain"},
    ]
    edit = _edit(tmp_path, [(0, 90)], items)
    cache = tmp_path / "cache"
    result = _render(edit, cache)
    chunks = result["chunks"]
    out = cache / result["folder"]
    assert [(c["start"], c["end"]) for c in chunks] == [(0, 20), (30, 50), (60, 80)]
    # The same text shares one still; the look depends only on the text and the canvas.
    assert chunks[0]["png"] == chunks[1]["png"] != chunks[2]["png"]
    assert result["drawn"] == 2
    assert sorted(p.name for p in out.iterdir()) == sorted({c["png"] for c in chunks})
    for name in {c["png"] for c in chunks}:
        assert _png_size_and_mode(out / name) == (W, H, 6)  # RGBA
        alpha = _alpha(out / name)
        layout = captions_ass.layout_for(W, H)
        # Text is drawn (opaque pixels) inside the safe zone only; the rest is transparent.
        drawn = [i for i, a in enumerate(alpha) if a > 0]
        assert drawn and max(a for a in alpha) == 255
        rows = {i // W for i in drawn}
        assert min(rows) >= layout.safe[1] and max(rows) < layout.safe[3]
    # No temp folder is left in the cache.
    assert [entry.name for entry in cache.iterdir()] == [result["folder"]]


@pytest.mark.usefixtures("tools")
def test_a_change_draws_only_its_new_texts(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 90)], [{"id": "c1", "start": 0, "duration": 20, "text": "hello there"}])
    cache = tmp_path / "cache"
    first = _render(edit, cache)
    assert first["drawn"] == 1
    # Undo back to the same captions, or a trim that only moves them: nothing is drawn.
    edit["tracks"][1]["items"][0]["start"] = 10
    assert _render(edit, cache)["drawn"] == 0
    edit["tracks"][1]["items"].append({"id": "c2", "start": 40, "duration": 20, "text": "new words"})
    again = _render(edit, cache)
    assert again["drawn"] == 1 and again["folder"] == first["folder"]


def test_the_look_hashes_the_style_and_the_render_version(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    before = captions.look_key(W, H)
    assert captions.look_key(H, W) != before
    monkeypatch.setattr(captions, "RENDER_VERSION", captions.RENDER_VERSION + 1)
    assert captions.look_key(W, H) != before
    monkeypatch.undo()
    styles = tmp_path / "styles"
    shutil.copytree(captions_ass.STYLES_DIR, styles)
    monkeypatch.setattr(captions_ass, "STYLES_DIR", styles)
    assert captions.look_key(W, H) == before
    style = styles / f"{captions_ass.DEFAULT_STYLE}.json"
    style.write_text(style.read_text(encoding="utf-8").replace("#FFFFFF", "#FFFFFE"), encoding="utf-8")
    assert captions.look_key(W, H) != before


def test_the_look_follows_the_edits_style() -> None:
    # S7V-037: each look has its own stills, so switching back and forth never redraws.
    keys = {preset: captions.look_key(W, H, preset) for preset in captions_ass.presets()}
    assert len(set(keys.values())) == len(keys) == 4
    assert captions.look_key(W, H) == keys["s7-neutral"]
    # Four looks at one canvas fit the cache's look count.
    assert captions.KEEP_LOOKS >= len(keys)


@pytest.mark.usefixtures("tools")
def test_the_stills_follow_the_tracks_style(tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 90)], [{"id": "c1", "start": 0, "duration": 20, "text": "hello there"}])
    cache = tmp_path / "cache"
    neutral = _render(edit, cache)
    edit["tracks"][1]["style"] = "s7-box"
    boxed = _render(edit, cache)
    assert boxed["folder"] == captions.look_key(W, H, "s7-box") != neutral["folder"]
    assert boxed["drawn"] == 1 and [(c["start"], c["end"]) for c in boxed["chunks"]] == [(0, 20)]
    # The box covers more of the canvas than the bare text, and stays in the safe zone.
    plain_alpha = _alpha(cache / neutral["folder"] / neutral["chunks"][0]["png"])
    box_alpha = _alpha(cache / boxed["folder"] / boxed["chunks"][0]["png"])
    assert sum(a > 0 for a in box_alpha) > sum(a > 0 for a in plain_alpha)
    layout = captions_ass.layout_for(W, H, captions_ass.load_style("s7-box"))
    rows = {i // W for i, a in enumerate(box_alpha) if a > 0}
    assert min(rows) >= layout.safe[1] and max(rows) < layout.safe[3]
    # Back to the plain look: its stills are still cached.
    edit["tracks"][1]["style"] = "s7-neutral"
    assert _render(edit, cache)["drawn"] == 0


@pytest.mark.usefixtures("tools")
def test_karaoke_draws_one_still_per_word_state(tmp_path: Path) -> None:
    words = [{"text": "Say", "start": 0, "duration": 8}, {"text": "it", "start": 10, "duration": 5}, {"text": "loud", "start": 15, "duration": 10}]
    edit = _edit(tmp_path, [(0, 90)], [{"id": "c1", "start": 0, "duration": 25, "text": "Say it loud", "words": words}])
    edit["tracks"][1]["style"] = "s7-karaoke"
    cache = tmp_path / "cache"
    result = _render(edit, cache)
    chunks = result["chunks"]
    # One entry per word being said, each from its word's first frame to the next word's.
    assert [(c["start"], c["end"]) for c in chunks] == [(0, 10), (10, 15), (15, 25)]
    assert len({c["png"] for c in chunks}) == result["drawn"] == 3
    folder = cache / result["folder"]
    # Only the colour of the lit word changes: the same glyphs cover (nearly) the same pixels.
    covered = [sum(a > 0 for a in _alpha(folder / c["png"])) for c in chunks]
    assert max(covered) - min(covered) <= 0.01 * max(covered), covered
    assert len({(folder / c["png"]).read_bytes() for c in chunks}) == 3
    # The export draws the same events: one per word state, on the same frames.
    plan = export.plan_segments(edit, W, H)
    cues = captions_ass.cues(export.export_chunks(edit, plan, {}), export.caption_style(edit))
    assert [(cue.start, cue.end, cue.lit) for cue in cues] == [(0, 10, 0), (10, 15, 1), (15, 25, 2)]


@pytest.mark.usefixtures("tools")
def test_a_failed_render_leaves_no_temp_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    edit = _edit(tmp_path, [(0, 90)], [{"id": "c1", "start": 0, "duration": 20, "text": "hello"}])
    cache = tmp_path / "cache"

    def broken(*_args: Any, **_kwargs: Any) -> bytes:
        raise RpcError(MEDIA_ERROR, "ffmpeg could not read the media")

    monkeypatch.setattr(captions, "run_tool", broken)
    with pytest.raises(RpcError):
        _render(edit, cache)
    assert [entry.name for entry in cache.iterdir() if entry.name.startswith(".tmp-")] == []


def test_prune_keeps_the_newest_looks_and_never_counts_temp_folders(tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    for index in range(captions.KEEP_LOOKS + 3):
        look = cache / f"look{index}"
        look.mkdir(parents=True)
        os.utime(look, (1000 + index, 1000 + index))
    fresh, stale = cache / ".tmp-fresh", cache / ".tmp-stale"
    fresh.mkdir()
    stale.mkdir()
    os.utime(stale, (1, 1))
    captions._prune(cache, "look0")
    left = sorted(entry.name for entry in cache.iterdir())
    newest = [f"look{index}" for index in range(captions.KEEP_LOOKS + 3)][-(captions.KEEP_LOOKS - 1) :]
    assert left == sorted([".tmp-fresh", "look0", *newest])


@pytest.mark.usefixtures("tools")
def test_fallback_stills_equal_the_stills_of_an_added_track(tmp_path: Path) -> None:
    """With transcripts and no caption track the export burns in transcript captions; so does the player."""
    edit = _edit(tmp_path, [(0, 40), (60, 90), (120, 160)], [])
    transcript = _transcript(SPOKEN)
    cache = tmp_path / "cache"
    fallback = _render(edit, cache, [transcript])
    assert len(fallback["chunks"]) >= 4
    plan = export.plan_segments(edit, W, H)
    assert [(c["start"], c["end"]) for c in fallback["chunks"]] == [
        (c.start, c.end) for c in export.export_chunks(edit, plan, {"transcripts": [transcript]})
    ]
    edit["tracks"][1]["items"] = _track_items(plan, transcript)
    tracked = _render(edit, cache, [transcript])
    assert tracked["chunks"] == fallback["chunks"] and tracked["drawn"] == 0
    # A muted caption track means no captions, in the export and the player.
    edit["tracks"][1]["muted"] = True
    assert _render(edit, cache, [transcript])["chunks"] == []


@pytest.mark.usefixtures("tools")
def test_reply_size_for_a_ten_minute_edit(tmp_path: Path) -> None:
    """Records the stills' size for 10 minutes of talk in base64, as `captions.stills` sent them before S7V-079."""
    rate = Fraction(30)
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"")
    minutes = 10
    edit = make_edit(source=source, ranges=[(0, minutes * 60 * 30)], fps=rate, duration_frames=minutes * 60 * 30, captions=[])
    stored = json.loads((Path(__file__).parents[3] / "fixtures" / "media" / "talking-head-01.transcript.json").read_text("utf-8"))
    real = [(w["text"], w["startFrame"], w["endFrame"]) for w in stored["words"]]
    loop = stored["durationFrames"]
    # The real talk's own timing (its rate is close to 24 fps; read at 30 it only runs faster),
    # repeated to 10 minutes, the words shifted each time so the texts stay distinct.
    spoken = []
    for repeat in range(minutes * 60 * 30 // loop + 1):
        for index, (_, start, end) in enumerate(real):
            text = real[(index + repeat * 5) % len(real)][0]
            if repeat * loop + end < minutes * 60 * 30:
                spoken.append((text, repeat * loop + start, repeat * loop + end))
    started = time.perf_counter()
    result = _render(edit, tmp_path / "cache", [_transcript(spoken)])
    seconds = time.perf_counter() - started
    folder = tmp_path / "cache" / result["folder"]
    names = {chunk["png"] for chunk in result["chunks"]}
    reply = sum(math.ceil((folder / name).stat().st_size / 3) * 4 for name in names)
    print(
        f"10-minute edit at 1080x1920: {len(result['chunks'])} chunks, {len(names)} stills,"
        f" {reply / 1e6:.2f} MB of base64, drawn in {seconds:.2f} s"
    )
    assert len(result["chunks"]) > 400
    # A regression guard, not a target: about 28 KB of base64 per distinct text (S7V-075 review).
    assert reply < 32_000_000
    # S7V-037: the highlighted look has one entry per word being said; the server's 200 KB reply
    # test (CaptionStillsService.test.ts) allows 4 per chunk, the looks' maxWords.
    chunks = captions.chunks_of(edit, [_transcript(spoken)])
    states = captions_ass.cues(chunks, "s7-karaoke")
    print(f"10-minute edit in s7-karaoke: {len(states)} word states for {len(chunks)} chunks")
    assert len(states) <= 4 * len(chunks)


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize("preset", ["s7-neutral", "s7-box", "s7-karaoke", "s7-minimal"])
@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1920, 1080)])
def test_preview_is_a_small_band_of_the_sample_caption(tmp_path: Path, preset: str, width: int, height: int) -> None:
    cache = tmp_path / "cache"
    params = {"preset": preset, "width": width, "height": height, "cacheDir": str(cache)}
    result = captions._preview(params, JobContext.detached())
    still = cache / result["folder"] / result["png"]
    # Cached in the look's own folder, beside the stills the player shows in that look.
    assert result["folder"] == captions.look_key(width, height, preset)
    preview_width, preview_height, colour = _png_size_and_mode(still)
    assert (preview_width, colour) == (captions.PREVIEW_WIDTH, 2)  # RGB
    assert 24 <= preview_height <= 80
    assert still.stat().st_size < 64_000
    # Drawn once: asking again reads the cache.
    mtime = still.stat().st_mtime_ns
    assert captions._preview(params, JobContext.detached()) == result
    assert still.stat().st_mtime_ns == mtime
    assert [entry.name for entry in cache.iterdir() if entry.name.startswith(".tmp-")] == []


def test_preview_band_frames_the_sample_line() -> None:
    for preset in captions_ass.presets():
        for width, height in [(1080, 1920), (1080, 1080), (1920, 1080)]:
            left, top, right, bottom = captions.preview_band(width, height, preset)
            layout = captions_ass.layout_for(width, height, captions_ass.load_style(preset))
            assert 0 <= left < right <= width and 0 <= top < bottom <= height
            assert (right - left) % 2 == (bottom - top) % 2 == 0
            # The line's bottom edge is inside the band, with room above for its height.
            assert top < height - layout.margin_bottom - layout.font_size < height - layout.margin_bottom < bottom


def test_preview_refuses_a_look_that_is_not_ours(tmp_path: Path) -> None:
    with pytest.raises(RpcError, match="is not one of ours"):
        captions._preview({"preset": "kigaru", "width": 1080, "height": 1920, "cacheDir": str(tmp_path)}, JobContext.detached())


def test_render_over_rpc_refuses_bad_params(wire: Wire, tmp_path: Path) -> None:
    reply = wire.call("captions.render", {"edit": {"version": 1}, "cacheDir": str(tmp_path)})
    assert reply["error"]["code"] == -32602
    reply = wire.call("captions.render", {"edit": _edit(tmp_path, [(0, 30)], []), "cacheDir": "relative"})
    assert reply["error"]["code"] == -32602
