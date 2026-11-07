# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``timeline-edit-roundtrip``, export half (S7V-034).

The TypeScript half (``apps/server/src/edit/timeline-edit-roundtrip.golden.test.ts``) edits
``talking-head-01`` after the silence cut with timeline gestures (moves, trims, a split, a delete
that leaves a gap and a ripple delete) and stores the resulting items in
``references/timeline-edit-roundtrip.json``. This half renders that edit with ``export.render``
(S7V-028) and matches every output frame to the source: each clip's frames are the expected source
frames, in timeline order, gaps are black, and the frame count is the edit's length. The undo half
checks that the cut edit it returns to has the silence cut's frame count.
Run with ``pnpm test:golden -- timeline-edit-roundtrip``.
"""

from __future__ import annotations

import json
import os
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

import harness
from s7engine.jobs import JobContext
from s7engine.methods import export

REFERENCES = Path(__file__).parent / "references"
REFERENCE = REFERENCES / "timeline-edit-roundtrip.json"
SILENCE_CUT = REFERENCES / "silence-cut-talking-head.json"
WIDTH, HEIGHT = 360, 640
THUMB = (72, 128)


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _gray_frames(path: Path, prefix: str) -> list[bytes]:
    cover = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT}," if prefix else ""
    chain = f"{prefix}{cover}scale={THUMB[0]}:{THUMB[1]}:flags=area,format=gray"
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf", chain, "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    step = THUMB[0] * THUMB[1]
    return [raw[index * step : (index + 1) * step] for index in range(len(raw) // step)]


def _mse(a: bytes, b: bytes) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)


def _edit(source: Path, reference: dict[str, Any]) -> dict[str, Any]:
    rate = Fraction(reference["rate"])
    items = [
        {"id": f"v{index}", "media": "cam", "start": start, "duration": duration, "in": source_in}
        for index, (start, duration, source_in) in enumerate(reference["items"])
    ]
    return {
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


def test_undo_returns_to_the_silence_cut() -> None:
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    cut = json.loads(SILENCE_CUT.read_text(encoding="utf-8"))["rates"][reference["rate"]]
    assert reference["mediaFrames"] == cut["mediaFrames"]
    assert reference["cutFrames"] == sum(end - start for start, end in cut["ranges"])


def test_timeline_edit_export_is_frame_exact(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    rate = Fraction(reference["rate"])
    edit = _edit(source, reference)
    out = tmp_path / "edited.mp4"
    result = export._render(
        {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(out), "captions": False}, JobContext.detached()
    )
    total = reference["durationFrames"]
    assert result["durationFrames"] == total
    assert harness.probe_summary(out)["video_frames"] == total

    by_frame: dict[int, int] = {}
    for start, duration, source_in in reference["items"]:
        for offset in range(duration):
            by_frame[start + offset] = source_in + offset
    source_frames = _gray_frames(source, f"fps={rate.numerator}/{rate.denominator},")
    output_frames = _gray_frames(out, "")
    assert len(output_frames) == total
    mismatches = []
    gap_frames = 0
    for position, frame in enumerate(output_frames):
        want = by_frame.get(position)
        if want is None:
            gap_frames += 1
            assert sum(frame) / len(frame) < 20, f"frame {position} in a gap is not black"
            continue
        window = range(max(0, want - 2), min(len(source_frames), want + 3))
        got = min(window, key=lambda candidate: (_mse(frame, source_frames[candidate]), abs(candidate - want)))
        # At 29.97 the rate change repeats source pictures: a repeat of the wanted picture is it.
        if got != want and source_frames[got] != source_frames[want]:
            mismatches.append((position, want, got))
    assert mismatches == [], mismatches[:10]
    assert gap_frames == total - len(by_frame)
    print(f"\ntimeline-edit-roundtrip: {len(reference['items'])} clips, {total} frames, {gap_frames} black, cut list exact")
    out.unlink()
