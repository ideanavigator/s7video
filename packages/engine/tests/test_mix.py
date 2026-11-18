# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""The export's sound effect and music mix (S7V-036, ``s7engine/mix.py``): Tier 1 and 2.

Sounds here are synthetic tones made at test time; never library or client sounds.
"""

from __future__ import annotations

import array
import math
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from engine_support import FFMPEG, FFPROBE
from export_support import make_edit

from s7engine import mix
from s7engine.methods import export, loudness
from s7engine.jobs import JobContext
from s7engine.rpc import RpcError


def _edit_with_sound(tmp_path: Path, *, rate: Fraction = Fraction(30), tracks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    source = tmp_path / "cam.mp4"
    source.write_bytes(b"x")
    edit = make_edit(source=source, ranges=[(0, 300)], fps=rate, duration_frames=300)
    for media_id in ("tick", "bed"):
        edit["media"].append(
            {
                "id": media_id,
                "kind": "audio",
                "reference": str(tmp_path / f"{media_id}.wav"),
                "fingerprint": {"sha256": "1" * 64, "size": 1},
                "probe": {"hasVideo": False, "hasAudio": True, "durationFrames": 900},
            }
        )
    edit["tracks"] += tracks or []
    return edit


def _plan(edit: dict[str, Any]) -> tuple[export.Plan, str]:
    plan = export.plan_segments(edit, 1080, 1920)
    plan.sources["cam"] = export.Source(str(edit["media"][0]["reference"]), Fraction(0), True, False)
    inputs, assignment = export.assign_inputs(plan)
    return plan, export.build_graph(plan, inputs, assignment, video=True, ass_file=None)


SFX = {"kind": "sfx", "id": "S1", "items": [{"id": "s", "media": "tick", "start": 37, "duration": 6, "in": 0, "gainDb": -9.5}]}
DUCK = {"depthDb": -12, "attackFrames": 4, "releaseFrames": 12, "ranges": [{"start": 30, "end": 60}]}
MUSIC = {
    "kind": "music",
    "id": "M1",
    "duck": DUCK,
    "items": [{"id": "m", "media": "bed", "start": 0, "duration": 300, "in": 0, "gainDb": -18, "fadeInFrames": 15, "fadeOutFrames": 30}],
}


# --- Tier 1 ------------------------------------------------------------------------------------


@pytest.mark.parametrize("rate", [Fraction(25), Fraction(30), Fraction(30000, 1001), Fraction(24000, 1001)])
def test_chain_delays_to_exact_sample(tmp_path: Path, rate: Fraction) -> None:
    plan, graph = _plan(_edit_with_sound(tmp_path, rate=rate, tracks=[SFX]))
    first = plan.sample_at(37)
    assert first == round(Fraction(37) * 48_000 / rate)
    assert f"adelay=delays={first}S|{first}S" in graph
    # Six frames of the file from its start, padded to the edit's exact sample count.
    assert f"atrim=start_sample=0:end_sample={plan.sample_at(43) - first}" in graph
    assert f"apad=whole_len={plan.sample_at(300)},atrim=end_sample={plan.sample_at(300)}" in graph
    assert "volume=-9.50dB" in graph


def test_graph_has_one_loudness_volume(tmp_path: Path) -> None:
    plan, graph = _plan(_edit_with_sound(tmp_path, tracks=[SFX, MUSIC]))
    render = f"{graph};\n[amix]{export.loudness_chain(export.fixed_gain(-20.0))}[aout]"
    assert "[voice][x0][x1]amix=inputs=3:normalize=0:duration=first[amix]" in render
    # The mix is read once, by the loudness chain: one volume, then the peak limiter.
    readers = [line for line in render.splitlines() if line.startswith("[amix]")]
    assert len(readers) == 1 and readers[0].count("volume=") == 1 and readers[0].count("alimiter=") == 1
    for dynamic in ("dynaudnorm", "loudnorm", "acompressor", "sidechaincompress", "compand", "agate"):
        assert dynamic not in render


def test_sfx_and_music_are_planned_but_overlays_are_refused(tmp_path: Path) -> None:
    plan, _ = _plan(_edit_with_sound(tmp_path, tracks=[SFX, MUSIC]))
    assert [(item.media, item.start, item.frames) for item in plan.audio] == [("tick", 37, 6), ("bed", 0, 300)]
    overlay = {"kind": "overlay", "id": "O1", "items": [{"id": "o", "text": "hi", "start": 0, "duration": 10}]}
    with pytest.raises(RpcError, match="export cannot draw overlay tracks yet"):
        export.plan_segments(_edit_with_sound(tmp_path, tracks=[overlay]), 1080, 1920)


def test_sound_on_a_media_without_audio_is_refused(tmp_path: Path) -> None:
    edit = _edit_with_sound(tmp_path, tracks=[SFX])
    edit["media"][1]["probe"]["hasAudio"] = False
    with pytest.raises(RpcError, match='media "tick" on a sound track has no sound'):
        export.plan_segments(edit, 1080, 1920)


def test_items_are_trimmed_at_the_end_of_the_video_and_still_fade_out(tmp_path: Path) -> None:
    long_sfx = {"kind": "sfx", "id": "S1", "items": [{"id": "s", "media": "tick", "start": 290, "duration": 40, "in": 3}]}
    music = {**MUSIC, "items": [{**MUSIC["items"][0], "duration": 400}]}  # type: ignore[dict-item]
    late = {"kind": "sfx", "id": "S2", "items": [{"id": "z", "media": "tick", "start": 300, "duration": 5, "in": 0}]}
    plan, graph = _plan(_edit_with_sound(tmp_path, tracks=[long_sfx, music, late]))
    assert [(item.start, item.frames, item.source_in, item.fade_out, item.cut_short) for item in plan.audio] == [
        (290, 10, 3, 0, True),
        (0, 300, 0, 30, True),
    ]
    total = plan.sample_at(300)
    # Music: its own 1 s fade-out, moved to end where the video ends.
    assert f"afade=t=out:ss={total - (total - plan.sample_at(270))}:ns={total - plan.sample_at(270)}" in graph
    # The sound effect has no fade-out of its own, so it gets 10 ms (480 samples) at the cut.
    sfx = next(line for line in graph.splitlines() if line.endswith("[x0];") or line.endswith("[x0]"))
    played = plan.sample_at(300) - plan.sample_at(290)
    assert f"afade=t=out:ss={played - 480}:ns=480" in sfx
    # An item that plays whole keeps its sharp end: nothing cut it.
    whole, _ = _plan(_edit_with_sound(tmp_path, tracks=[SFX]))
    assert not whole.audio[0].cut_short


def test_a_sound_placed_to_end_at_the_video_end_still_fades(tmp_path: Path) -> None:
    # As placement writes it: a 40-frame file at frame 290 of a 300-frame edit is placed 10 frames
    # long, so its duration already ends where the video does while the file goes on.
    placed = {"kind": "sfx", "id": "S1", "items": [{"id": "s", "media": "tick", "start": 290, "duration": 10, "in": 0}]}
    edit = _edit_with_sound(tmp_path, tracks=[placed])
    edit["media"][1]["probe"]["durationFrames"] = 40
    plan, graph = _plan(edit)
    assert plan.audio[0].cut_short
    played = plan.sample_at(300) - plan.sample_at(290)
    assert f"afade=t=out:ss={played - 480}:ns=480" in graph
    # The same item when the file itself ends there: its own end, no fade added.
    edit["media"][1]["probe"]["durationFrames"] = 10
    plan, graph = _plan(edit)
    assert not plan.audio[0].cut_short
    chain = next(line for line in graph.splitlines() if line.startswith("[1:a:0]"))
    assert "afade" not in chain


def test_muted_music_track_is_left_out(tmp_path: Path) -> None:
    plan, graph = _plan(_edit_with_sound(tmp_path, tracks=[{**MUSIC, "muted": True}]))
    assert plan.audio == []
    assert "amix=" not in graph and "[voice]" not in graph
    assert "concat=n=1:v=1:a=1[vcat][amix]" in graph


def test_duck_curve_corners() -> None:
    duck = mix.Duck(-12.0, 4, 12, ((30, 60),))
    pieces = mix.duck_pieces(duck, Fraction(30), 300)
    corners = [(float(t0), float(v0)) for t0, _, v0, _ in pieces] + [(float(pieces[-1][1]), float(pieces[-1][3]))]
    # Down over 4 frames before the range, held through it, back up over 12 after, flat elsewhere.
    assert corners == [(0.0, 0.0), (26 / 30, 0.0), (1.0, 1.0), (2.0, 1.0), (2.4, 0.0), (10.0, 0.0)]


def test_overlapping_duck_curves_take_the_deeper_level() -> None:
    # A 9-frame pause: the release (12) and the next attack (4) overlap and meet above zero.
    duck = mix.Duck(-12.0, 4, 12, ((30, 60), (69, 90)))
    pieces = mix.duck_pieces(duck, Fraction(30), 120)
    lowest = min(min(v0, v1) for t0, t1, v0, v1 in pieces if Fraction(60, 30) <= t0 and t1 <= Fraction(69, 30))
    # Release at t: 1 - (t - 2) / 0.4; attack: 1 - (2.3 - t) / (4/30); they meet at t = 2.225.
    assert lowest == Fraction(7, 16)
    assert all(v0 >= 0 and v1 <= 1 for _, _, v0, v1 in pieces)


def test_duck_ranges_are_sorted_and_merged() -> None:
    track = {"kind": "music", "duck": {"depthDb": -12, "attackFrames": 4, "releaseFrames": 12, "ranges": [{"start": 50, "end": 70}, {"start": 10, "end": 30}, {"start": 25, "end": 40}]}}
    duck = mix.duck_of(track)
    assert duck is not None and duck.ranges == ((10, 40), (50, 70))
    assert mix.duck_of({"kind": "music", "duck": {**track["duck"], "depthDb": 0}}) is None  # type: ignore[dict-item]
    assert mix.duck_of({"kind": "music", "duck": {**track["duck"], "ranges": []}}) is None  # type: ignore[dict-item]


def test_duck_expression_is_a_shallow_tree() -> None:
    ranges = tuple((start, start + 20) for start in range(0, 30_000, 40))  # 750 ranges
    expression = mix.duck_expression(mix.Duck(-12.0, 4, 12, ranges), Fraction(30), 30_000)
    depth, deepest = 0, 0
    for char in expression:
        depth += {"(": 1, ")": -1}.get(char, 0)
        deepest = max(deepest, depth)
    assert deepest < 40
    assert expression.startswith("pow(10,-12*if(lt(t,")


# --- Tier 2 with FFmpeg ------------------------------------------------------------------------


def _mono(path: Path) -> array.array[float]:
    assert FFMPEG is not None
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-ac", "1", "-f", "f32le", "-"], check=True, capture_output=True).stdout
    samples = array.array("f")
    samples.frombytes(raw)
    return samples


def _rms_db(samples: array.array[float], start: int, end: int) -> float:
    window = samples[start:end]
    return 10 * math.log10(sum(value * value for value in window) / len(window) + 1e-20)


@pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="needs ffmpeg")
def test_mono_44k_asset_resampled_once_and_ducked(tmp_path: Path) -> None:
    assert FFMPEG is not None and FFPROBE is not None
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=f=1000:d=0.2:sample_rate=44100", "-ac", "1", str(tmp_path / "tick.wav")], check=True)
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=12:sample_rate=44100", "-ac", "1", str(tmp_path / "bed.wav")], check=True)
    music = {**MUSIC, "items": [{**MUSIC["items"][0], "gainDb": 0, "fadeInFrames": 0, "fadeOutFrames": 0}]}  # type: ignore[dict-item]
    edit = _edit_with_sound(tmp_path, tracks=[{**SFX, "items": [{**SFX["items"][0], "gainDb": 0}]}, music])  # type: ignore[dict-item]
    edit["tracks"][0]["muted"] = True  # voice silent: the mix is the two sounds
    plan, _ = _plan(edit)
    inputs, assignment = export.assign_inputs(plan)
    graph = export.build_graph(plan, inputs, assignment, video=False, ass_file=None)
    # One format step per item: the only resample is the one FFmpeg inserts for it.
    assert graph.count("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo") == 2
    assert "aresample" not in graph.split("[voice]")[-1]
    script = tmp_path / "mix.txt"
    script.write_text(graph)
    out = tmp_path / "mix.wav"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-t", "11", "-i", "anullsrc=r=48000:cl=stereo", "-i", str(tmp_path / "tick.wav"), "-i", str(tmp_path / "bed.wav"),
         "-/filter_complex", str(script), "-map", "[amix]", "-c:a", "pcm_f32le", str(out)],
        check=True,
    )
    probe = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=sample_rate,channels,duration_ts", "-of", "csv=p=0", str(out)], check=True, capture_output=True, text=True).stdout
    assert probe.strip() == f"48000,2,{plan.sample_at(300)}"
    samples = _mono(out)
    # The tick adds to the bed from its first sample on.
    at = plan.sample_at(37)
    assert _rms_db(samples, at, at + 480) - _rms_db(samples, at - 2400, at - 480) > 3
    # Ducked by 12 dB through the range (frames 30-60), back to full 12 frames after it.
    held = _rms_db(samples, plan.sample_at(45), plan.sample_at(55))
    open_ = _rms_db(samples, plan.sample_at(80), plan.sample_at(120))
    assert abs(open_ - held - 12) < 0.2


@pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="needs ffmpeg")
def test_media_loudness_loops_short_sounds_and_reports_silence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert FFMPEG is not None and FFPROBE is not None
    monkeypatch.setenv("S7_FFMPEG", FFMPEG)
    monkeypatch.setenv("S7_FFPROBE", FFPROBE)
    tone = "sine=f=1000:sample_rate=48000:d="
    for name, spec in (("short", f"{tone}0.2"), ("long", f"{tone}5"), ("quiet", "anullsrc=r=48000:cl=mono:d=2")):
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", spec, str(tmp_path / f"{name}.wav")], check=True)

    def measure(name: str) -> float | None:
        return loudness._loudness({"path": str(tmp_path / f"{name}.wav")}, JobContext.detached())["integratedLufs"]

    long, short = measure("long"), measure("short")
    assert long is not None and short is not None
    # Under 400 ms ebur128 has no block (-70); looped, the short tone reads as loud as the long one.
    assert abs(short - long) < 0.3
    assert measure("quiet") is None
    with pytest.raises(RpcError, match="no sound"):
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=1", "-frames:v", "1", str(tmp_path / "still.png")], check=True)
        loudness._loudness({"path": str(tmp_path / "still.png")}, JobContext.detached())
