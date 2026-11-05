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
    assert harness.ssim(clip, clip) == pytest.approx(1.0, abs=1e-6)


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
    report = harness.word_timing_diff(expected, actual, fps)
    assert not report.missing
    assert report.start_errors_ms == pytest.approx([20.0, 0.0])
    assert report.within_one_frame == 1.0
    assert report.passes()
    late = harness.word_timing_diff(expected, [{"text": "hello", "start": 1.3, "end": 1.6}], fps)
    assert [w["text"] for w in late.missing] == ["world"]
    assert not late.passes()


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
    actual = [{"text": w["text"], "start": w["start"] / fps, "end": w["end"] / fps} for w in words]
    assert harness.word_timing_diff(words, actual, fps).passes()


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
