# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``mix-sfx-music-lufs``: ``export.render`` mixes sound effects and music (S7V-036).

The edit is ``talking-head-01`` cut to its silence-cut keep ranges (``talking-head-01.keep.json``:
26 ranges, 2,994 frames at 24000/1001), with two synthetic sounds made at test time:

- a 0.12 s 1 kHz click (44.1 kHz mono) on the fifth word the cut keeps, at the "normal" sound
  effect level (−9 dB under the voice);
- a bed of two sines and pink noise under the whole edit at −18 dB, with 0.5 s and 1 s fades,
  ducked −12 dB under speech (attack 150 ms, release 400 ms, in whole frames).

The levels go through ``media.loudness`` as the server converts them (``audioLevels.ts``). The speech
ranges are the transcript's words (``talking-head-01.transcript.json``) mapped through the cut by
the engine's ``map_words`` and merged across gaps under 300 ms, as ``video_duck_music`` maps them.
The export renders at 360×640, since the sound is what is measured, and is checked on:

- **loudness** (AC-3): −14 LUFS ±1 LU, within 0.5 LU of the reference, true peak ≤ −1.0 dBTP;
- **SFX timing** (AC-4): the SFX stem's first sample above −30 dBFS is within ±1 frame of the word;
- **ducking** (AC-5): the music stem under speech is 12 ±1 dB below its level in the longest gap;
- **one fixed gain** (AC-6): after the loudness chain minus before it is one constant, within
  0.1 dB, wherever the limiter is idle;
- **A/V sync and format** from ``harness.probe_summary``.

Stems come from the export's own graph with the other tracks muted, so they are the same chains as
in the mix. They are deleted when the test ends. The reference holds data only. A legitimate change
is recorded with ``S7VIDEO_GOLDEN_UPDATE=1`` and explained in the PR.
Run with ``pnpm test:golden -- mix-sfx-music-lufs``.
"""

from __future__ import annotations

import copy
import json
import math
import os
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import harness
from export_support import make_edit
from s7engine import captions_from_words, mix
from s7engine.jobs import JobContext
from s7engine.methods import export, loudness

REFERENCE = Path(__file__).parent / "references" / "mix-sfx-music-lufs.json"
FIXTURES = harness.REPO_ROOT / "fixtures" / "media"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
WIDTH, HEIGHT = 360, 640
# The server's presets (apps/server/src/edit/audioLevels.ts), relative to the voice.
SFX_NORMAL_DB, MUSIC_BED_DB, DUCK_DB = -9.0, -18.0, -12.0
SFX_WORD = 4  # the fifth kept word
LUFS_TOLERANCE = 0.5
ONSET_DBFS = -30.0


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _frames(seconds: Fraction) -> int:
    """Whole frames at the edit rate, half up, as the server rounds them."""
    return math.floor(seconds * RATE + Fraction(1, 2))


def _sound(path: Path, graph: str) -> Path:
    harness._run([harness._tool("ffmpeg"), "-v", "error", "-y", "-filter_complex", graph, "-ac", "1", "-c:a", "pcm_s16le", str(path)])
    return path


def _loudness(path: Path) -> float:
    value = loudness._loudness({"path": str(path)}, JobContext.detached())["integratedLufs"]
    assert value is not None
    return value


def _speech_ranges(plan: export.Plan, transcript: dict[str, Any]) -> list[tuple[int, int]]:
    words = [word for run in captions_from_words.map_words(plan.segments, {"cam": transcript}, RATE) for word in run]
    words.sort(key=lambda word: word.start)
    ranges: list[tuple[int, int]] = []
    for word in words:
        # Under 300 ms: gap / rate < 3/10.
        if ranges and Fraction(word.start - ranges[-1][1]) / RATE < Fraction(3, 10):
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], word.end))
        else:
            ranges.append((word.start, word.end))
    return ranges


def _render_stems(edit: dict[str, Any], outputs: dict[str, Path], tail: str, work: Path) -> None:
    """The edit's audio graph (``build_graph``, no video) with ``tail`` mapping labels to WAV files."""
    plan = export.plan_segments(edit, WIDTH, HEIGHT)
    media = {entry["id"]: entry for entry in edit["media"]}
    plan.sources["cam"] = export._probe_source(media["cam"]["reference"], JobContext.detached())
    inputs, assignment = export.assign_inputs(plan)
    args: list[str] = []
    for entry in inputs:
        args += ["-t", export._seconds(entry.read_seconds), "-i", plan.sources[entry.media].path]
    for item in plan.audio:
        args += ["-t", export._seconds(mix.read_seconds(item, RATE)), "-i", media[item.media]["reference"]]
    script = work / "stems.txt"
    script.write_text(export.build_graph(plan, inputs, assignment, video=False, ass_file=None) + tail, encoding="utf-8")
    for label, path in outputs.items():
        args += ["-map", f"[{label}]", "-ac", "1", "-c:a", "pcm_f32le", str(path)]
    harness._run([harness._tool("ffmpeg"), "-v", "error", "-y", "-/filter_complex", str(script), *args])


def _samples(path: Path) -> np.ndarray:
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-"], check=True, capture_output=True
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


def _rms_db(samples: np.ndarray, start_frame: int, end_frame: int) -> float:
    window = samples[mix.sample_at(start_frame, RATE) : mix.sample_at(end_frame, RATE)].astype(np.float64)
    return 10 * math.log10(float(np.mean(window * window)) + 1e-20)


def _muted(edit: dict[str, Any], *kinds: str) -> dict[str, Any]:
    variant = copy.deepcopy(edit)
    for track in variant["tracks"]:
        if track["kind"] in kinds:
            track["muted"] = True
    return variant


def test_mix_sfx_music_lufs(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    work = tmp_path / "work"
    work.mkdir()
    try:
        _run_golden(source, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _run_golden(source: Path, work: Path) -> None:
    keep = [tuple(entry) for entry in json.loads((FIXTURES / "talking-head-01.keep.json").read_text(encoding="utf-8"))["keep"]]
    transcript = json.loads((FIXTURES / "talking-head-01.transcript.json").read_text(encoding="utf-8"))
    edit = make_edit(source=source, ranges=keep, fps=RATE, duration_frames=SOURCE_FRAMES, width=WIDTH, height=HEIGHT)
    plan = export.plan_segments(edit, WIDTH, HEIGHT)
    total = plan.total_frames

    click = _sound(work / "click.wav", "sine=f=1000:d=0.12:sample_rate=44100,afade=t=out:st=0.02:d=0.1")
    bed_seconds = float(Fraction(total) / RATE) + 2
    bed = _sound(
        work / "bed.wav",
        f"sine=f=220:d={bed_seconds}:sample_rate=48000[a];sine=f=330:d={bed_seconds}:sample_rate=48000[b];"
        f"anoisesrc=d={bed_seconds}:c=pink:a=0.05:r=48000[c];[a][b][c]amix=inputs=3:normalize=0,volume=-12dB",
    )
    voice_lufs, click_lufs, bed_lufs = _loudness(source), _loudness(click), _loudness(bed)
    click_gain = round(voice_lufs + SFX_NORMAL_DB - click_lufs, 1)
    bed_gain = round(voice_lufs + MUSIC_BED_DB - bed_lufs, 1)

    words = [word for run in captions_from_words.map_words(plan.segments, {"cam": transcript}, RATE) for word in run]
    target = sorted(words, key=lambda word: word.start)[SFX_WORD]
    ranges = _speech_ranges(plan, transcript)
    attack, release = _frames(Fraction(15, 100)), _frames(Fraction(4, 10))
    click_frames = _frames(Fraction(12, 100))
    for media_id, path, frames in (("click", click, click_frames), ("bed", bed, _frames(Fraction(bed_seconds)))):
        edit["media"].append(
            {
                "id": media_id,
                "kind": "audio",
                "reference": str(path),
                "fingerprint": {"sha256": "0" * 64, "size": path.stat().st_size},
                "probe": {"hasVideo": False, "hasAudio": True, "durationFrames": frames},
            }
        )
    edit["tracks"] += [
        {"kind": "sfx", "id": "S1", "items": [{"id": "sfx0", "media": "click", "start": target.start, "duration": click_frames, "in": 0, "gainDb": click_gain}]},
        {
            "kind": "music",
            "id": "M1",
            "duck": {
                "depthDb": DUCK_DB,
                "attackFrames": attack,
                "releaseFrames": release,
                "ranges": [{"start": start, "end": end} for start, end in ranges],
            },
            "items": [
                {
                    "id": "bed0",
                    "media": "bed",
                    "start": 0,
                    "duration": total,
                    "in": 0,
                    "gainDb": bed_gain,
                    "fadeInFrames": _frames(Fraction(1, 2)),
                    "fadeOutFrames": _frames(Fraction(1)),
                }
            ],
        },
    ]

    out = work / "mix.mp4"
    result = export._render(
        {"edit": edit, "projectDir": str(work), "outputPath": str(out), "captions": False, "canvas": {"width": WIDTH, "height": HEIGHT}},
        JobContext.detached(),
    )
    loud = harness.loudness(out)
    summary = harness.probe_summary(out)

    # Stems through the export's own graph: the click alone, the music alone, the mix before and
    # after the loudness chain.
    _render_stems(_muted(edit, "video", "music"), {"amix": work / "sfx.wav"}, "", work)
    _render_stems(_muted(edit, "video", "sfx"), {"amix": work / "music.wav"}, "", work)
    gain = export.Gain(result["measuredLufs"], result["gainDb"])
    _render_stems(
        edit,
        {"pre": work / "pre.wav", "post": work / "post.wav"},
        f";\n[amix]asplit=2[pre][g];\n[g]{export.loudness_chain(gain)}[post]",
        work,
    )

    sfx = _samples(work / "sfx.wav")
    onset = int(np.argmax(np.abs(sfx) > 10 ** (ONSET_DBFS / 20)))
    onset_frames = (onset - mix.sample_at(target.start, RATE)) * float(RATE) / mix.SAMPLE_RATE

    music = _samples(work / "music.wav")
    fade_in, fade_out = _frames(Fraction(1, 2)), _frames(Fraction(1))
    gaps = [(a[1], b[0]) for a, b in zip(ranges, ranges[1:]) if a[1] > fade_in and b[0] < total - fade_out]
    gap = max(gaps, key=lambda span: span[1] - span[0])
    speech = max(ranges, key=lambda span: span[1] - span[0])
    gap_db = _rms_db(music, gap[0] + release + 1, gap[1] - attack - 1)
    speech_db = _rms_db(music, speech[0] + 1, speech[1] - 1)

    pre, post = _samples(work / "pre.wav"), _samples(work / "post.wav")
    window = 960  # 20 ms
    count = min(len(pre), len(post)) // window
    pre_w = pre[: count * window].reshape(count, window).astype(np.float64)
    post_w = post[: count * window].reshape(count, window).astype(np.float64)
    gain_linear = 10 ** (gain.gain_db / 20)
    peaks = np.abs(pre_w).max(axis=1) * gain_linear
    # Idle limiter: no peak near its ceiling within 3 windows (60 ms; attack 5 ms, release 50 ms).
    hot = np.convolve(peaks > 0.7 * 10 ** (export.LIMIT_DBFS / 20), np.ones(7), mode="same") > 0
    level = np.sqrt(np.mean(pre_w * pre_w, axis=1))
    idle = ~hot & (level > 10 ** (-50 / 20))
    differences = 20 * np.log10(np.sqrt(np.mean(post_w[idle] ** 2, axis=1)) / level[idle])

    observed = {
        "clip": "talking-head-01",
        "totalFrames": total,
        "sfxWord": [target.text, target.start],
        "duckRanges": [list(span) for span in ranges],
        "duck": {"attackFrames": attack, "releaseFrames": release},
        "levels": {"voice": voice_lufs, "click": click_lufs, "bed": bed_lufs, "clickGainDb": click_gain, "bedGainDb": bed_gain},
        "measuredLufs": result["measuredLufs"],
        "gainDb": result["gainDb"],
        "lufs": loud.integrated_lufs,
        "truePeak": loud.true_peak_dbtp,
        "sfxOnsetFrames": round(onset_frames, 3),
        "music": {"gap": list(gap), "gapDb": round(gap_db, 2), "speech": list(speech), "speechDb": round(speech_db, 2)},
        "gainSteadiness": {"windows": int(idle.sum()), "minDb": round(float(differences.min()), 3), "maxDb": round(float(differences.max()), 3)},
        "summary": summary,
    }
    print(f"\nmix-sfx-music-lufs: {json.dumps({key: value for key, value in observed.items() if key not in ('duckRanges', 'summary')})}")
    if UPDATE:
        REFERENCE.write_text(json.dumps(observed, indent=2) + "\n", encoding="utf-8")
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))

    # The edit and the levels are what the server would write.
    assert observed["duckRanges"] == reference["duckRanges"]
    assert observed["sfxWord"] == reference["sfxWord"]
    assert (attack, release) == (4, 10)  # 150 ms and 400 ms at 23.976 fps

    # AC-3: loudness and true peak, against the target and the reference.
    assert abs(loud.integrated_lufs - export.TARGET_LUFS) <= 1.0, loud
    assert abs(loud.integrated_lufs - reference["lufs"]) <= LUFS_TOLERANCE, loud
    assert loud.true_peak_dbtp <= -1.0, loud
    assert result["lufs"] is not None and abs(result["lufs"] - loud.integrated_lufs) < 0.15

    # AC-4: the click lands on its word.
    assert abs(onset_frames) <= 1.0, onset_frames

    # AC-5: the music dips by the duck depth under speech.
    assert abs((gap_db - speech_db) - abs(DUCK_DB)) <= 1.0, (gap_db, speech_db)

    # AC-6: one constant gain wherever the limiter is idle.
    assert idle.sum() > count // 4, "too few windows with the limiter idle to check the gain"
    assert np.all(np.abs(differences - gain.gain_db) <= 0.1), (float(differences.min()), float(differences.max()), gain.gain_db)

    # Format and A/V sync: the audio starts with the video, never more than 20 ms ahead, and lasts
    # as long.
    assert summary == reference["summary"]
    assert (summary["audio_codec"], summary["audio_rate"], summary["audio_channels"]) == ("aac", 48000, 2)
    assert summary["video_frames"] == result["durationFrames"] == total
    frame_s = float(1 / RATE)
    assert abs(summary["audio_start_s"] - summary["video_start_s"]) <= frame_s
    assert summary["video_start_s"] - summary["audio_start_s"] <= 0.02
    assert abs(summary["audio_duration_s"] - total * frame_s) <= frame_s
