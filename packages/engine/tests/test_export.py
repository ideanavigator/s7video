# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`export.render` and its caption file (S7V-028): Tier 1 units and Tier 2 edge cases.

Real renders use small synthetic clips whose frames carry their own number as 12 bits of black and
white blocks, with a white flash band and a 1 kHz beep on every twelfth frame. Decoding the blocks
back gives the export's cut list frame by frame; the beeps against the flashes give A/V sync.
"""

from __future__ import annotations

import math
import os
import stat
import subprocess
import threading
import time
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from engine_support import FFMPEG, Wire, needs_ffmpeg
from export_support import decode_audio_mono, decode_gray, make_edit, stream_info

from s7engine import captions_ass, rpc
from s7engine.jobs import Cancelled, JobContext
from s7engine.methods import export

W, H = 288, 512
BITS = 12


# --- Synthetic clips ---------------------------------------------------------------------------


def coded_clip(path: Path, fps: str, seconds: float, *, audio: bool = True, extra_video: str = "", vcodec: list[str] | None = None) -> Path:
    """Frame n shows n in binary (12 blocks across the middle third) and flashes when n % 12 == 0."""
    assert FFMPEG is not None
    lum = (
        f"if(between(Y\\,{H // 3}\\,{2 * H // 3})\\,if(mod(floor(N/pow(2\\,floor(X*{BITS}/W)))\\,2)\\,235\\,16)\\,"
        f"if(lt(Y\\,{H // 4})*eq(mod(N\\,12)\\,0)\\,235\\,16))"
    )
    video = f"color=c=black:s={W}x{H}:r={fps}:d={seconds},geq=lum='{lum}':cb=128:cr=128{extra_video}"
    args = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", video]
    if audio:
        beep = f"if(lt(mod(t*{fps}\\,12)\\,1)\\,0.4*sin(2*PI*1000*t)\\,0)"
        args += ["-f", "lavfi", "-i", f"aevalsrc='{beep}|{beep}':s=48000:d={seconds}"]
    args += vcodec or ["-c:v", "mpeg4", "-q:v", "2", "-g", "12"]
    if audio:
        args += ["-c:a", "aac", "-b:a", "192k"]
    subprocess.run([*args, str(path)], check=True)
    return path


def frame_codes(path: Path) -> list[int]:
    """The number each frame of a coded clip shows (or of its export at the same size)."""
    raw = decode_gray(path, f"{BITS}x8")
    codes = []
    for index in range(len(raw) // (BITS * 8)):
        frame = raw[index * BITS * 8 : (index + 1) * BITS * 8]
        row = frame[4 * BITS : 5 * BITS]
        codes.append(sum(1 << bit for bit in range(BITS) if row[bit] > 125))
    return codes


def av_offsets_ms(path: Path, fps: Fraction) -> list[float]:
    """Each beep's onset minus the time of the flash frame nearest it, in ms (beeps with no flash
    within two frames, whose picture was cut or dropped, are skipped)."""
    raw = decode_gray(path, "4x4")
    flashes = [index for index in range(len(raw) // 16) if raw[index * 16] > 125]
    samples = decode_audio_mono(path)
    onsets, loud = [], False
    for at in range(0, len(samples) - 48, 48):
        now = max(abs(value) for value in samples[at : at + 48]) > 0.05
        if now and not loud:
            onsets.append(at / 48_000)
        loud = now
    offsets = []
    for onset in onsets:
        nearest = min(flashes, key=lambda frame: abs(float(frame / fps) - onset))
        offset = (onset - float(nearest / fps)) * 1000
        if abs(offset) <= 2000 / fps:
            offsets.append(offset)
    return offsets


@pytest.fixture(scope="module")
def clip_30(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if FFMPEG is None:
        pytest.skip("needs ffmpeg")
    return coded_clip(tmp_path_factory.mktemp("export") / "coded-30.mp4", "30", 12)


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch) -> None:
    from engine_support import FFPROBE

    if FFMPEG is None or FFPROBE is None:
        pytest.skip("needs ffmpeg and ffprobe")
    monkeypatch.setenv("S7_FFMPEG", FFMPEG)
    monkeypatch.setenv("S7_FFPROBE", FFPROBE)


def run_export(edit: dict[str, Any], out: Path, **params: Any) -> dict[str, Any]:
    return export._render({"edit": edit, "projectDir": str(out.parent), "outputPath": str(out), **params}, JobContext.detached())


def expected_codes(ranges: list[tuple[int, int]]) -> list[int]:
    return [frame for start, end in ranges for frame in range(start, end)]


# --- Tier 1: units -----------------------------------------------------------------------------


def test_filter_graph_from_keep_ranges(tmp_path: Path) -> None:
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"x")
    ranges = [(0, 30), (45, 90), (120, 121)]
    edit = make_edit(source=source, ranges=ranges, fps=Fraction(30), duration_frames=300)
    edit["tracks"][0]["items"][2]["start"] = 80  # a 5-frame gap before the last item
    plan = export.plan_segments(edit, 1080, 1920)
    plan.sources["cam"] = export.Source(str(source), Fraction(0), True, False)
    inputs, assignment = export.assign_inputs(plan)
    graph = export.build_graph(plan, inputs, assignment, video=True, ass_file=None)

    assert plan.total_frames == 81
    assert [(s.timeline_start, s.frames, s.source_in) for s in plan.segments] == [(0, 30, 0), (30, 45, 45), (75, 5, 0), (80, 1, 120)]
    assert plan.segments[2].media is None
    assert "trim=start_frame=0:end_frame=30" in graph
    assert "trim=start_frame=45:end_frame=90" in graph
    assert "trim=start_frame=120:end_frame=121" in graph
    assert "color=c=black:s=1080x1920:r=30/1,trim=end_frame=5" in graph
    assert "[0:v:0]fps=30/1,split=3" in graph
    assert "concat=n=4:v=1:a=1" in graph
    assert len(inputs) == 1 and assignment == [0, 0, None, 0]


def test_going_back_in_a_source_opens_it_again(tmp_path: Path) -> None:
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"x")
    edit = make_edit(source=source, ranges=[(100, 130), (0, 20), (20, 40)], fps=Fraction(30), duration_frames=300)
    plan = export.plan_segments(edit, 1080, 1920)
    plan.sources["cam"] = export.Source(str(source), Fraction(1, 100), True, False)
    inputs, assignment = export.assign_inputs(plan)
    assert assignment == [0, 1, 1]
    # Each input reads up to its last needed frame plus a second, from the video's first frame.
    assert inputs[0].read_seconds == Fraction(1, 100) + Fraction(130, 30) + 1
    assert inputs[1].read_seconds == Fraction(1, 100) + Fraction(40, 30) + 1


def test_fades_do_not_move_cuts() -> None:
    plan = export.Plan(Fraction(30000, 1001), 1080, 1920, 0, [])
    boundaries = [0, 1, 7, 100, 101, 1999]
    total = 0
    for start, end in zip(boundaries, boundaries[1:]):
        samples = plan.sample_at(end) - plan.sample_at(start)
        total += samples
        chain = export._audio_chain(samples, export.Segment(start, end - start, "cam"))
        fade = min(480, samples // 2)
        # Both fades sit inside the segment's own samples, which are cut to the exact count.
        assert f"apad=whole_len={samples},atrim=end_sample={samples}" in chain
        assert f"afade=t=in:ns={fade}" in chain
        assert f"afade=t=out:ss={samples - fade}:ns={fade}" in chain
    # Cumulative sample boundaries: 29.97 fps has a fractional samples-per-frame and never drifts.
    assert total == plan.sample_at(1999) == round(Fraction(1999 * 48000 * 1001, 30000))


def test_ass_chunks_two_to_four_words() -> None:
    rate = Fraction(30)
    words = [captions_ass.Word(f"w{i}", i * 10, i * 10 + 8) for i in range(11)]
    sizes = [len(c.text.split()) for c in captions_ass.chunk_words(words, rate)]
    assert sizes == [4, 4, 3]

    # A pause (≥ 0.3 s) or a sentence end starts a new phrase; 5 words split 3 + 2, never 4 + 1.
    paused = [captions_ass.Word(t, s, s + 5) for t, s in [("one", 0), ("two", 6), ("three.", 12), ("four", 18), ("five", 24), ("six", 30), ("seven", 36), ("eight", 42), ("nine", 100), ("ten", 106)]]
    chunks = captions_ass.chunk_words(paused, rate)
    assert [c.text for c in chunks] == ["one two three.", "four five six", "seven eight", "nine ten"]
    assert all(2 <= len(c.text.split()) <= 4 for c in chunks)
    # A chunk runs from its first word's start to its last word's end.
    assert (chunks[1].start, chunks[1].end) == (18, 35)


def test_caption_items_without_word_timings_spread_by_characters() -> None:
    chunks = captions_ass.caption_chunks(
        [{"id": "c", "start": 30, "duration": 60, "text": "aaaa bb cccc dd eeee ff"}], Fraction(30), 1000
    )
    assert [c.text for c in chunks] == ["aaaa bb cccc", "dd eeee ff"]
    assert chunks[0].start == 30 and chunks[-1].end == 90
    assert chunks[0].end <= chunks[1].start


def test_chunks_are_clipped_to_the_timeline_and_never_overlap() -> None:
    items = [
        {"id": "a", "start": 0, "duration": 50, "text": "a b", "words": [{"text": "a", "start": 0, "duration": 20}, {"text": "b", "start": 20, "duration": 30}]},
        {"id": "b", "start": 40, "duration": 30, "text": "c d", "words": [{"text": "c", "start": 40, "duration": 10}, {"text": "d", "start": 50, "duration": 20}]},
    ]
    chunks = captions_ass.caption_chunks(items, Fraction(30), 60)
    assert [(c.start, c.end) for c in chunks] == [(0, 40), (40, 60)]


@pytest.mark.parametrize("rate", [Fraction(24000, 1001), Fraction(25), Fraction(30), Fraction(30000, 1001), Fraction(60)])
def test_caption_times_land_on_their_frames(rate: Fraction) -> None:
    # FFmpeg's subtitles filter asks libass for int(pts * time_base * 1000) as a double.
    def libass_ms(frame: int) -> int:
        return int(frame * float(1 / rate) * 1000)

    for frame in range(1, 20_000):
        boundary = captions_ass.frame_to_ms(frame, rate)
        assert boundary % 10 == 0
        assert libass_ms(frame - 1) < boundary <= libass_ms(frame), frame


@pytest.mark.parametrize(("width", "height", "kind"), [(1080, 1920, "portrait"), (1080, 1080, "square"), (1920, 1080, "landscape"), (720, 1280, "portrait")])
def test_ass_layout_inside_safe_zone(width: int, height: int, kind: str) -> None:
    assert captions_ass.aspect_class(width, height) == kind
    layout = captions_ass.layout_for(width, height)
    left, top, right, bottom = layout.safe
    assert 0 < left < right < width and 0 < top < bottom < height
    assert layout.margin_left == left and width - layout.margin_right + math.ceil(layout.shadow) == right
    assert height - layout.margin_bottom + math.ceil(layout.shadow) == bottom
    # Two lines of text and the shadow fit between the top of the safe zone and its bottom.
    assert bottom - 2.5 * layout.font_size - layout.shadow > top
    subs = captions_ass.build_ass([captions_ass.Chunk("hello there", 0, 30)], Fraction(30), width, height)
    style = subs.styles["Default"]
    assert (style.marginl, style.marginr, style.marginv) == (layout.margin_left, layout.margin_right, layout.margin_bottom)
    assert style.alignment == 2 and style.outline == 0 and style.shadow > 0 and style.borderstyle == 1
    assert style.fontname == "Inter" and style.bold
    assert subs.info["PlayResX"] == str(width) and subs.info["PlayResY"] == str(height)


def test_caption_text_cannot_inject_ass_tags() -> None:
    subs = captions_ass.build_ass([captions_ass.Chunk(r"{\pos(0,0)}hi \N there", 0, 30)], Fraction(30), 1080, 1920)
    assert "{" not in subs.events[0].text and "\\" not in subs.events[0].text


def test_fixed_gain_from_measurement() -> None:
    assert export.fixed_gain(-21.1).gain_db == 7.1
    assert export.fixed_gain(-9.5).gain_db == -4.5
    assert export.fixed_gain(-70.0).gain_db == 0.0  # silence stays silence
    assert export.fixed_gain(-math.inf).gain_db == 0.0
    assert export.fixed_gain(-49.0).gain_db == 30.0  # capped
    chain = export.loudness_chain(export.fixed_gain(-20.0))
    assert chain.startswith("volume=6.0dB,alimiter=")
    # The limiter is a ceiling only: no auto-levelling (pumping) and no lookahead delay.
    assert "level=0" in chain and "latency=1" in chain and "limit=0.8414" in chain
    assert export.loudness_chain(export.fixed_gain(-70.0)).startswith("alimiter=")


def test_ebur128_summary_parse() -> None:
    stderr = "noise\n[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -21.1 LUFS\n    Threshold: -31.4 LUFS\n\n  True peak:\n    Peak:       -3.2 dBFS\n"
    assert export.parse_ebur128(stderr) == (-21.1, -3.2)
    with pytest.raises(rpc.RpcError):
        export.parse_ebur128("no summary")


def test_progress_parse() -> None:
    total = Fraction(10)
    assert export.parse_progress("out_time_us=5000000\n", total) == 0.5
    assert export.parse_progress("out_time_ms=12000000", total) == 1.0
    assert export.parse_progress("out_time_us=-34000", total) == 0.0
    assert export.parse_progress("out_time_us=N/A", total) is None
    assert export.parse_progress("frame=12", total) is None
    assert export.parse_progress("progress=end", total) is None


def test_unsupported_tracks_fail_plainly(tmp_path: Path) -> None:
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"x")
    edit = make_edit(source=source, ranges=[(0, 30)], fps=Fraction(30), duration_frames=300)
    edit["tracks"].append({"kind": "music", "id": "M1", "items": [{"id": "m", "media": "cam", "start": 0, "duration": 10, "in": 0}]})
    with pytest.raises(rpc.RpcError, match="export cannot draw music tracks yet"):
        export.plan_segments(edit, 1080, 1920)
    edit["tracks"].pop()
    edit["tracks"][0]["items"][0]["zoom"] = {"scale": 1.2, "anchorX": 0.5, "anchorY": 0.5, "rampFrames": 0}
    with pytest.raises(rpc.RpcError, match="zoom"):
        export.plan_segments(edit, 1080, 1920)


# --- Tier 1 with FFmpeg: the caption file on real frames ---------------------------------------


def _caption_bbox(ass: Path, width: int, height: int, cwd: Path) -> tuple[int, int, int, int] | None:
    assert FFMPEG is not None
    captions_ass.link_fonts(cwd / "fonts")
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"color=c=0x404040:s={width}x{height}:r=30:d=0.5", "-vf",
         f"subtitles=filename={ass.name}:fontsdir=fonts,format=gray", "-frames:v", "1", "-ss", "0.2", "-f", "rawvideo", "-"],
        check=True, capture_output=True, cwd=cwd,
    ).stdout
    # Anything not the 0x40 background is text (white) or shadow (black).
    xs, ys = [], []
    for y in range(height):
        row = raw[y * width : (y + 1) * width]
        for x in range(0, width):
            if abs(row[x] - 0x40) > 24:
                xs.append(x)
                ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


@needs_ffmpeg
@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1080, 1080), (1920, 1080)])
@pytest.mark.parametrize("text", ["Wikipedia's Arbitration Committee decides", "Supercalifragilisticexpialidocious", "WWWW MMMM WWWW MMMM"])
def test_rendered_captions_stay_inside_safe_zone(tmp_path: Path, width: int, height: int, text: str) -> None:
    captions_ass.write_ass(tmp_path / "c.ass", [captions_ass.Chunk(text, 0, 30)], Fraction(30), width, height)
    box = _caption_bbox(tmp_path / "c.ass", width, height, tmp_path)
    assert box is not None, "the caption was not drawn"
    left, top, right, bottom = captions_ass.layout_for(width, height).safe
    assert left <= box[0] and box[2] < right, (box, (left, right))
    assert top <= box[1] and box[3] < bottom, (box, (top, bottom))


@needs_ffmpeg
def test_captions_use_only_the_bundled_font(tmp_path: Path) -> None:
    assert FFMPEG is not None
    captions_ass.write_ass(tmp_path / "c.ass", [captions_ass.Chunk("Hello there", 0, 30)], Fraction(30), 1080, 1920)
    captions_ass.link_fonts(tmp_path / "fonts")
    log = subprocess.run(
        [FFMPEG, "-v", "debug", "-f", "lavfi", "-i", "color=s=1080x1920:r=30:d=0.2", "-vf",
         "subtitles=filename=c.ass:fontsdir=fonts", "-f", "null", "-"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    ).stderr
    loaded = [line.split("'")[1] for line in log.splitlines() if "Loading font file" in line]
    selected = [line.split("->", 1)[1].strip() for line in log.splitlines() if "fontselect" in line]
    # libass reads only our file, and every caption glyph run resolves to it (Inter is not a
    # system font, so "Inter-Bold" can only be the bundled one).
    assert set(loaded) == {"fonts/Inter-Bold.ttf"}
    assert selected and all(name.startswith("Inter-Bold,") for name in selected), selected
    assert sorted(p.name for p in captions_ass.FONTS_DIR.iterdir()) == ["Inter-Bold.ttf", "OFL.txt"]
    assert "SIL Open Font License, Version 1.1" in (captions_ass.FONTS_DIR / "OFL.txt").read_text()


# --- Tier 2: real exports ----------------------------------------------------------------------


@pytest.mark.usefixtures("tools")
def test_export_cut_list_sync_and_format(clip_30: Path, tmp_path: Path) -> None:
    ranges = [(3, 40), (52, 53), (60, 133), (200, 290)]
    edit = make_edit(source=clip_30, ranges=ranges, fps=Fraction(30), duration_frames=360, width=W, height=H)
    result = run_export(edit, tmp_path / "out.mp4")

    out = Path(result["path"])
    assert result["durationFrames"] == 201 and result["captions"] == 0
    assert frame_codes(out) == expected_codes(ranges)
    info = stream_info(out)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["codec_name"], video["profile"], video["pix_fmt"]) == ("h264", "High", "yuv420p")
    assert (video["color_primaries"], video["color_transfer"], video["color_space"], video["color_range"]) == ("bt709", "bt709", "bt709", "tv")
    assert (audio["codec_name"], audio["profile"], audio["sample_rate"], audio["channels"]) == ("aac", "LC", "48000", 2)
    assert "mp4" in info["format"]["format_name"]
    with out.open("rb") as file:
        head = file.read(64 * 1024)
    assert head.find(b"moov") < head.find(b"mdat") or b"mdat" not in head  # faststart
    offsets = av_offsets_ms(out, Fraction(30))
    assert len(offsets) >= 15
    assert all(-20 <= offset <= 1000 / 30 for offset in offsets), offsets
    assert abs(offsets[-1] - offsets[0]) < 1.0
    assert not list(tmp_path.glob("*.part"))


@pytest.mark.usefixtures("tools")
def test_export_without_transcript(clip_30: Path, tmp_path: Path) -> None:
    edit = make_edit(source=clip_30, ranges=[(0, 30)], fps=Fraction(30), duration_frames=360, width=W, height=H, captions=[])
    result = run_export(edit, tmp_path / "out.mp4")
    assert result["captions"] == 0 and Path(result["path"]).is_file()


@pytest.mark.usefixtures("tools")
def test_captions_off_draws_none(clip_30: Path, tmp_path: Path) -> None:
    caption = {"id": "c", "start": 0, "duration": 20, "text": "hello there"}
    edit = make_edit(source=clip_30, ranges=[(0, 30)], fps=Fraction(30), duration_frames=360, width=W, height=H, captions=[caption])
    assert run_export(edit, tmp_path / "on.mp4")["captions"] == 1
    assert run_export(edit, tmp_path / "off.mp4", captions=False)["captions"] == 0


@pytest.mark.usefixtures("tools")
def test_silent_source_stays_silent(tmp_path: Path) -> None:
    assert FFMPEG is not None
    source = tmp_path / "silent.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s={W}x{H}:r=30:d=3", "-f", "lavfi", "-i",
         "anoisesrc=a=0.0005:r=48000:d=3", "-c:v", "mpeg4", "-c:a", "aac", "-ac", "2", str(source)],
        check=True,
    )
    edit = make_edit(source=source, ranges=[(0, 60)], fps=Fraction(30), duration_frames=90, width=W, height=H)
    result = run_export(edit, tmp_path / "out.mp4")
    assert result["gainDb"] == 0.0
    assert result["lufs"] is None or result["lufs"] < -50
    peak = max(abs(value) for value in decode_audio_mono(Path(result["path"])))
    assert peak < 0.01


@pytest.mark.usefixtures("tools")
def test_source_without_audio_exports_silence(tmp_path: Path) -> None:
    source = coded_clip(tmp_path / "mute.mp4", "30", 2, audio=False)
    edit = make_edit(source=source, ranges=[(0, 20), (30, 45)], fps=Fraction(30), duration_frames=60, width=W, height=H, has_audio=False)
    out = Path(run_export(edit, tmp_path / "out.mp4")["path"])
    assert frame_codes(out) == expected_codes([(0, 20), (30, 45)])
    audio = next(s for s in stream_info(out)["streams"] if s["codec_type"] == "audio")
    assert abs(float(audio["duration"]) - 35 / 30) < 0.03


@pytest.mark.usefixtures("tools")
def test_odd_fps_29_97(tmp_path: Path) -> None:
    source = coded_clip(tmp_path / "ntsc.mp4", "30000/1001", 10)
    rate = Fraction(30000, 1001)
    ranges = [(1, 31), (40, 41), (47, 107), (130, 240)]
    edit = make_edit(source=source, ranges=ranges, fps=rate, duration_frames=299, width=W, height=H)
    out = Path(run_export(edit, tmp_path / "out.mp4")["path"])
    assert frame_codes(out) == expected_codes(ranges)
    assert next(s for s in stream_info(out)["streams"] if s["codec_type"] == "video")["r_frame_rate"] == "30000/1001"
    offsets = av_offsets_ms(out, rate)
    assert offsets and all(-20 <= offset <= 1000 / float(rate) for offset in offsets), offsets


@pytest.mark.usefixtures("tools")
def test_vfr_phone_source(tmp_path: Path) -> None:
    # 60 fps with every 7th frame dropped and the timestamps kept: a variable-rate file.
    source = coded_clip(
        tmp_path / "vfr.mp4", "60", 6, extra_video=",select='not(eq(mod(n\\,7)\\,3))'",
        vcodec=["-c:v", "mpeg4", "-q:v", "2", "-fps_mode", "vfr"],
    )
    probe = next(s for s in stream_info(source)["streams"] if s["codec_type"] == "video")
    assert int(probe["nb_read_frames"]) < 360  # really variable
    rate = Fraction(30)
    ranges = [(2, 50), (70, 71), (90, 170)]
    edit = make_edit(source=source, ranges=ranges, fps=rate, duration_frames=180, width=W, height=H)
    out = Path(run_export(edit, tmp_path / "out.mp4")["path"])
    codes = frame_codes(out)
    # Frame n of the edit is the source picture at n / 30 s, i.e. 60 fps frame 2n (or its neighbour
    # when that one was dropped): the cut is mapped by timestamps, within one frame.
    expected = [2 * frame for frame in expected_codes(ranges)]
    assert len(codes) == len(expected)
    assert all(abs(code - want) <= 1 for code, want in zip(codes, expected)), list(zip(codes, expected))
    offsets = av_offsets_ms(out, rate)
    assert len(offsets) >= 10 and all(abs(offset) <= 1000 / 30 for offset in offsets), offsets


@pytest.mark.usefixtures("tools")
def test_hdr_source_tone_mapped(tmp_path: Path) -> None:
    assert FFMPEG is not None
    source = tmp_path / "hlg.mkv"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s={W}x{H}:r=30:d=2", "-f", "lavfi", "-i", "sine=r=48000:d=2",
         "-vf", "format=yuv420p10le", "-c:v", "ffv1", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
         "-colorspace", "bt2020nc", "-color_range", "tv", "-c:a", "pcm_s16le", str(source)],
        check=True,
    )
    edit = make_edit(source=source, ranges=[(0, 40)], fps=Fraction(30), duration_frames=60, width=W, height=H)
    out = Path(run_export(edit, tmp_path / "out.mp4")["path"])
    video = next(s for s in stream_info(out)["streams"] if s["codec_type"] == "video")
    assert (video["color_primaries"], video["color_transfer"], video["color_space"], video["pix_fmt"]) == ("bt709", "bt709", "bt709", "yuv420p")
    assert int(video["nb_read_frames"]) == 40
    luma = decode_gray(out, "1x1", ["-frames:v", "1"])[0]
    assert 30 < luma < 200  # a picture, not black or clipped white


# --- Tier 2: cancel, disk, missing tools -------------------------------------------------------


@pytest.fixture(scope="module")
def big_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if FFMPEG is None:
        pytest.skip("needs ffmpeg")
    path = tmp_path_factory.mktemp("export-big") / "big.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=40", "-f", "lavfi", "-i",
         "sine=r=48000:d=40", "-c:v", "mpeg4", "-q:v", "8", "-c:a", "aac", str(path)],
        check=True,
    )
    return path


@pytest.mark.usefixtures("tools")
def test_cancel_removes_partial_file(big_clip: Path, tmp_path: Path) -> None:
    wire = Wire()
    try:
        out = tmp_path / "exports" / "reel.mp4"
        out.parent.mkdir()
        edit = make_edit(source=big_clip, ranges=[(0, 1190)], fps=Fraction(30), duration_frames=1200)
        request = wire.request("export.render", {"jobId": "x1", "edit": edit, "projectDir": str(tmp_path), "outputPath": str(out)})
        wire.wait_for(lambda m: m.get("method") == "progress" and m["params"]["stage"] == "render" and m["params"]["progress"] > 0.2, timeout=60)
        assert Path(f"{out}.part").exists()
        started = time.monotonic()
        assert wire.call("job.cancel", {"jobId": "x1"})["result"] == {"cancelled": True}
        reply = wire.reply(request, timeout=5)
        assert time.monotonic() - started < 2
        assert reply["error"]["code"] == rpc.CANCELLED
        assert list(out.parent.iterdir()) == []
        # Progress came at least once a second while rendering.
        stamps = [m for m in wire.messages if m.get("method") == "progress" and m["params"]["jobId"] == "x1"]
        assert len(stamps) >= 3
    finally:
        wire.close()


def _fake_ffmpeg(tmp_path: Path, *, filters: str, render: str = 'exec "$REAL" "$@"') -> str:
    assert FFMPEG is not None
    script = tmp_path / "ffmpeg"
    script.write_text(
        "#!/bin/sh\n"
        f'REAL="{FFMPEG}"\n'
        'case "$*" in\n'
        f'  *-filters*) printf "%s\\n" "{filters}"; exit 0 ;;\n'
        '  *-encoders*) printf " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\\n"; exit 0 ;;\n'
        '  *-version*) printf "ffmpeg version 7.1.1\\n"; exit 0 ;;\n'
        f"  *render.txt*) {render} ;;\n"
        "esac\n"
        'exec "$REAL" "$@"\n'
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return str(script)


ALL_FILTERS = " ... subtitles         V->V       Render text subtitles\n ... zscale V->V z\n ... tonemap V->V t"


@pytest.mark.usefixtures("tools")
def test_missing_libass(clip_30: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", _fake_ffmpeg(tmp_path, filters=" ... ass  V->V  Render ASS"))
    caption = {"id": "c", "start": 0, "duration": 20, "text": "hello there"}
    edit = make_edit(source=clip_30, ranges=[(0, 30)], fps=Fraction(30), duration_frames=360, width=W, height=H, captions=[caption])
    with pytest.raises(rpc.RpcError) as raised:
        run_export(edit, tmp_path / "out.mp4")
    assert raised.value.code == rpc.MISSING_TOOL
    assert "libass" in raised.value.message
    assert raised.value.data == {"tool": "ffmpeg", "feature": "libass"}
    # Without captions the same FFmpeg is enough.
    assert run_export(edit, tmp_path / "plain.mp4", captions=False)["captions"] == 0


@pytest.mark.usefixtures("tools")
def test_missing_videotoolbox(clip_30: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = Path(_fake_ffmpeg(tmp_path, filters=ALL_FILTERS))
    fake.write_text(fake.read_text().replace("h264_videotoolbox", "libx264"))
    monkeypatch.setenv("S7_FFMPEG", str(fake))
    edit = make_edit(source=clip_30, ranges=[(0, 30)], fps=Fraction(30), duration_frames=360, width=W, height=H)
    with pytest.raises(rpc.RpcError, match="h264_videotoolbox") as raised:
        run_export(edit, tmp_path / "out.mp4")
    assert raised.value.data == {"tool": "ffmpeg", "feature": "h264_videotoolbox"}


@pytest.mark.usefixtures("tools")
def test_disk_full(clip_30: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out.mp4"
    edit = make_edit(source=clip_30, ranges=[(0, 30)], fps=Fraction(30), duration_frames=360, width=W, height=H)
    # FFmpeg runs out of space halfway: the partial file it wrote is removed.
    enospc = 'for last; do :; done; printf "partial" > "$last"; echo "Error writing trailer: No space left on device" >&2; exit 1'
    monkeypatch.setenv("S7_FFMPEG", _fake_ffmpeg(tmp_path, filters=ALL_FILTERS, render=enospc))
    job = JobContext("disk", None)
    with pytest.raises(rpc.RpcError, match="not enough free disk space") as raised:
        export._render({"edit": edit, "projectDir": str(tmp_path), "outputPath": str(out)}, job)
    assert raised.value.code == rpc.OUTPUT_ERROR
    job.discard_outputs()  # what the RPC server does after any failed job
    assert not out.exists() and not Path(f"{out}.part").exists()

    # Too little space up front: refused before anything is written.
    monkeypatch.setattr(export.shutil, "disk_usage", lambda _path: SimpleNamespace(free=1000))
    with pytest.raises(rpc.RpcError, match="not enough free disk space"):
        run_export(edit, out)
    assert not out.exists() and not Path(f"{out}.part").exists()


@pytest.mark.usefixtures("tools")
def test_output_rules(clip_30: Path, tmp_path: Path) -> None:
    edit = make_edit(source=clip_30, ranges=[(0, 30)], fps=Fraction(30), duration_frames=360, width=W, height=H)
    (tmp_path / "taken.mp4").write_bytes(b"x")
    for name, message in [("taken.mp4", "already exists"), ("missing/out.mp4", "exports folder"), ("out.mov", "absolute .mp4")]:
        with pytest.raises(rpc.RpcError, match=message):
            run_export(edit, tmp_path / name)
    edit["media"][0]["reference"] = str(tmp_path / "gone.mp4")
    with pytest.raises(rpc.RpcError, match='media "cam" is missing') as raised:
        run_export(edit, tmp_path / "out.mp4")
    assert raised.value.code == rpc.FILE_NOT_FOUND


@pytest.mark.usefixtures("tools")
def test_cancel_kills_only_its_own_ffmpeg(big_clip: Path, tmp_path: Path) -> None:
    edit = make_edit(source=big_clip, ranges=[(0, 600)], fps=Fraction(30), duration_frames=1200, width=540, height=960)
    rendering = [threading.Event(), threading.Event()]

    def progress(index: int):
        return lambda _value, stage: rendering[index].set() if stage == "render" else None

    jobs = [JobContext(f"j{i}", progress(i)) for i in range(2)]
    outcomes: dict[int, object] = {}

    def go(index: int) -> None:
        try:
            outcomes[index] = export._render({"edit": edit, "projectDir": str(tmp_path), "outputPath": str(tmp_path / f"o{index}.mp4")}, jobs[index])
        except (Cancelled, rpc.RpcError) as error:
            outcomes[index] = error

    threads = [threading.Thread(target=go, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    assert all(event.wait(60) for event in rendering)
    jobs[0].cancel()
    for thread in threads:
        thread.join(timeout=60)
    assert isinstance(outcomes[0], Cancelled)
    assert isinstance(outcomes[1], dict) and Path(outcomes[1]["path"]).is_file()


def _centre_yuv(path: Path) -> tuple[int, int, int]:
    """Mean Y, Cb, Cr of an 8×8 patch in the middle of the first frame, as stored (no conversion)."""
    assert FFMPEG is not None
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-vf", "crop=8:8:(iw-8)/2:(ih-8)/2,format=yuv444p",
         "-frames:v", "1", "-f", "rawvideo", "-"],
        check=True, capture_output=True,
    ).stdout
    planes = [raw[index * 64 : (index + 1) * 64] for index in range(3)]
    return tuple(round(sum(plane) / 64) for plane in planes)  # type: ignore[return-value]


@pytest.mark.usefixtures("tools")
@pytest.mark.parametrize(("tags", "converted"), [([], False), (["-colorspace", "bt470bg", "-color_primaries", "bt470bg", "-color_trc", "smpte170m"], True)])
def test_untagged_source_keeps_its_colours(tmp_path: Path, tags: list[str], converted: bool) -> None:
    # A flat colour stored as Y/Cb/Cr 127/95/67. Untagged means Rec.709 (media-standards.md), so the
    # export must keep the same values; a source tagged BT.601 is converted to 709 as it should be.
    assert FFMPEG is not None
    source = tmp_path / "flat.mkv"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r=30:d=1,format=yuv420p,geq=lum=127:cb=95:cr=67",
         "-f", "lavfi", "-i", "sine=r=48000:d=1", "-c:v", "ffv1", *tags, "-c:a", "pcm_s16le", str(source)],
        check=True,
    )
    assert _centre_yuv(source) == (127, 95, 67)
    edit = make_edit(source=source, ranges=[(0, 20)], fps=Fraction(30), duration_frames=30, width=W, height=H)
    y, cb, cr = _centre_yuv(Path(run_export(edit, tmp_path / "out.mp4")["path"]))
    unchanged = abs(y - 127) <= 3 and abs(cb - 95) <= 3 and abs(cr - 67) <= 3
    assert unchanged != converted, (y, cb, cr)


def test_untagged_matrix_is_read_as_rec709() -> None:
    plan = export.Plan(Fraction(30), 1080, 1920, 0, [])
    untagged = export.Source("/x", Fraction(0), True, False, untagged_matrix=True)
    tagged = export.Source("/x", Fraction(0), True, False, untagged_matrix=False)
    assert ":in_color_matrix=bt709:out_color_matrix=bt709" in export._video_chain(plan, untagged)
    assert "in_color_matrix" not in export._video_chain(plan, tagged)
