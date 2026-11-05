# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Unit and edge tests for the golden harness, on synthetic clips from fixtures/media/synth.ts."""

import json
from fractions import Fraction

import pytest

import harness

WORDS = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.words.json"
BEEPS = {
    "name": "harness-beeps",
    "fps": "30/1",
    "gop": 15,
    "audio": [{"seconds": 1, "toneHz": 440}, {"seconds": 0.5}, {"seconds": 0.5, "toneHz": 880}],
}


def test_ssim_identical_is_one(synth_clip):
    clip = synth_clip(BEEPS)
    result = harness.ssim(clip, clip)
    assert len(result.per_frame) == 60
    assert result.min == pytest.approx(1.0, abs=1e-6)
    assert result.mean == pytest.approx(1.0, abs=1e-6)


def test_ssim_refuses_clips_with_different_frame_counts(synth_clip):
    clip = synth_clip(BEEPS)
    shorter = synth_clip({**BEEPS, "name": "harness-beeps-short", "audio": [{"seconds": 1.5}]})
    with pytest.raises(harness.HarnessError, match="frame counts differ: reference 60, candidate 45"):
        harness.ssim(clip, shorter)


def test_phash_identical_frames_have_distance_zero(synth_clip):
    clip = synth_clip(BEEPS)
    assert harness.phash_distance(harness.phash(clip, 0), harness.phash(clip, 0)) == 0
    assert harness.phash_distance(harness.phash(clip, 0), harness.phash(clip, 45)) > 0


def test_probe_summary_counts_frames_exactly(synth_clip):
    summary = harness.probe_summary(synth_clip(BEEPS))
    assert summary["video_frames"] == 60
    assert summary["fps"] == "30/1"
    assert (summary["width"], summary["height"]) == (320, 180)
    assert (summary["audio_codec"], summary["audio_rate"]) == ("aac", 48000)
    assert summary["video_start_s"] == 0.0
    assert summary["audio_duration_s"] == pytest.approx(2.0, abs=0.05)
    assert {"color_range", "color_space", "color_transfer", "color_primaries"} <= summary.keys()


def test_lufs_calibrated_tone(synth_clip):
    tone = synth_clip(
        {
            "name": "harness-tone-minus-20",
            "audio": [{"seconds": 10, "toneHz": 1000, "dbfs": -20}],
            "container": "wav",
        }
    )
    level = harness.loudness(tone)
    assert level.integrated_lufs == pytest.approx(-20.0, abs=0.1)
    assert level.true_peak_dbtp == pytest.approx(-20.0, abs=0.5)


def test_cut_list_diff_reports_first_frame():
    expected = [(0, 10), (20, 30)]
    assert harness.cut_list_diff(expected, [(0, 10), (20, 30)]) is None
    assert harness.cut_list_diff(expected, [(0, 5), (5, 10), (20, 30)]) is None
    diff = harness.cut_list_diff(expected, [(0, 10), (21, 30)])
    assert diff == harness.CutDiff(output_frame=10, expected_source_frame=20, actual_source_frame=21)
    assert "output frame 10" in str(diff)


def test_cut_list_diff_reports_a_shorter_list():
    diff = harness.cut_list_diff([(0, 10)], [(0, 8)])
    assert diff == harness.CutDiff(output_frame=8, expected_source_frame=8, actual_source_frame=None)
    with pytest.raises(ValueError):
        harness.cut_list_diff([(5, 1)], [])


def test_word_timing_diff_measures_start_errors():
    fps = Fraction(25)
    expected = [{"text": "Hello", "start": 25, "end": 40}, {"text": "world", "start": 50, "end": 60}]
    actual = [{"text": "hello,", "start": 1.02, "end": 1.6}, {"w": "World", "start": 2.0, "end": 2.4}]
    report = harness.word_timing_diff(expected, actual, fps, actual_unit="seconds")
    assert not report.missing
    assert report.start_errors_ms == pytest.approx([20.0, 0.0])
    assert report.within_one_frame == 1.0
    assert report.passes()
    late = harness.word_timing_diff(
        expected, [{"text": "hello", "start": 1.3, "end": 1.6}], fps, actual_unit="seconds"
    )
    assert [w["text"] for w in late.missing] == ["world"]
    assert not late.passes()


def test_word_timing_diff_units_edges_and_apostrophes():
    fps = Fraction(25)
    expected = [
        {"text": "Let\u2019s", "start": 25, "end": 40, "startSeconds": 1.01, "startEdge": "pause"},
        {"text": "go", "start": 50, "end": 60, "startEdge": "dip"},
    ]
    in_frames = [{"text": "let's", "start": 25, "end": 40}, {"text": "go", "start": 60, "end": 70}]
    report = harness.word_timing_diff(expected, in_frames, fps, actual_unit="frames")
    assert not report.missing
    # startSeconds (1.01 s) is the reference, not the rounded frame (1.00 s).
    assert report.start_errors_ms == pytest.approx([-10.0])
    assert [m["scored"] for m in report.matched] == [True, False]
    assert report.passes()
    every = harness.word_timing_diff(
        expected, in_frames, fps, actual_unit="frames", score_edges=None
    )
    assert not every.passes()
    in_seconds = harness.word_timing_diff(
        expected, [{"w": "Let's", "startSeconds": 1.01, "endSeconds": 1.6}], fps, actual_unit="frames"
    )
    assert in_seconds.start_errors_ms == pytest.approx([0.0])


def test_hand_marked_words_file_is_well_formed():
    data = json.loads(WORDS.read_text(encoding="utf-8"))
    clip = harness.clip_entry("talking-head-01")
    assert data["clip"] == clip["id"] and data["sha256"] == clip["sha256"]
    fps = Fraction(data["fps"])
    words = data["words"]
    assert len(words) >= 30
    for word in words:
        assert isinstance(word["start"], int) and isinstance(word["end"], int)
        assert 0 <= word["start"] < word["end"]
        assert word["start"] == round(Fraction(str(word["startSeconds"])) * fps)
    assert [w["start"] for w in words] == sorted(w["start"] for w in words)
    # Every word is matched against itself with zero error.
    assert sum(w["startEdge"] in harness.SCORED_EDGES for w in words) >= 30
    report = harness.word_timing_diff(words, words, fps, actual_unit="frames")
    assert report.passes() and report.mean_abs_start_error_ms == 0


def test_media_fixture_skips_when_clip_is_missing(request, monkeypatch, tmp_path):
    monkeypatch.setenv("S7VIDEO_TEST_MEDIA_DIR", str(tmp_path))
    media = request.getfixturevalue("media")
    with pytest.raises(pytest.skip.Exception, match="run pnpm media:fetch"):
        media("talking-head-01")


def test_media_fixture_ignores_a_truncated_clip(monkeypatch, tmp_path):
    clip = harness.clip_entry("talking-head-01")
    (tmp_path / clip["file"]).write_bytes(b"\0" * 10)
    monkeypatch.setenv("S7VIDEO_TEST_MEDIA_DIR", str(tmp_path))
    assert harness.cached_clip("talking-head-01") is None
