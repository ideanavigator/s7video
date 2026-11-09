# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``text-edit-cut``, export half (S7V-038).

The TypeScript half (``apps/server/src/edit/text-edit-cut.golden.test.ts``) cuts ``talking-head-01``
by deleting 5 word selections in its transcript and restoring 2, and stores the items in
``references/text-edit-cut.json``. This half renders that edit with ``export.render`` and checks the
export's length (within 1 frame of the edit) and A/V sync (audio within 1 frame of the picture).
Run with ``pnpm test:golden -- text-edit-cut``.
"""

from __future__ import annotations

import json
import os
from fractions import Fraction
from pathlib import Path

import pytest

import harness
from s7engine.jobs import JobContext
from s7engine.methods import export

REFERENCE = Path(__file__).parent / "references" / "text-edit-cut.json"
WIDTH, HEIGHT = 360, 640


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def test_reference_cut_list_is_whole_frames() -> None:
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    at = 0
    for start, duration, source_in in reference["items"]:
        assert all(isinstance(value, int) for value in (start, duration, source_in))
        # Ripple deletes and restores leave the edit packed, with no gap or overlap.
        assert start == at
        at += duration
        assert source_in + duration <= reference["mediaFrames"]
    assert at == reference["durationFrames"]


def test_text_edit_export_length_and_sync(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    rate = Fraction(reference["rate"])
    items = [
        {"id": f"v{index}", "media": "cam", "start": start, "duration": duration, "in": source_in}
        for index, (start, duration, source_in) in enumerate(reference["items"])
    ]
    edit = {
        "version": 1,
        "fps": {"num": rate.numerator, "den": rate.denominator},
        "canvas": {"width": WIDTH, "height": HEIGHT},
        "media": [
            {
                "id": "cam",
                "kind": "video",
                "reference": str(source),
                "fingerprint": {"sha256": "0" * 64, "size": source.stat().st_size},
                "probe": {"hasVideo": True, "hasAudio": True, "durationFrames": reference["mediaFrames"]},
            }
        ],
        "tracks": [{"kind": "video", "id": "V1", "role": "main", "items": items}],
        "markers": [],
        "metadata": {},
    }
    out = tmp_path / "text-edit.mp4"
    export._render(
        {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(out), "captions": False}, JobContext.detached()
    )
    total = reference["durationFrames"]
    summary = harness.probe_summary(out)
    assert abs(summary["video_frames"] - total) <= 1
    frame_s = float(1 / rate)
    video_s = summary["video_frames"] * frame_s
    assert summary["audio_duration_s"] is not None
    assert abs(summary["audio_duration_s"] - video_s) <= frame_s
    assert abs((summary["audio_start_s"] or 0.0) - (summary["video_start_s"] or 0.0)) <= frame_s
    print(
        f"\ntext-edit-cut: {len(items)} clips, {summary['video_frames']} of {total} frames,"
        f" audio {summary['audio_duration_s']:.3f} s vs video {video_s:.3f} s"
    )
    out.unlink()
