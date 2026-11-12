# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``interchange-otio-fcpxml-edl``: "Export for editors" of ``talking-head-01`` (S7V-040).

The edit is the clip's silence cut (``fixtures/media/talking-head-01.keep.json``, 26 ranges at its
own 24000/1001, and retimed to 30000/1001) as a 1080×1920 reel. Its captions come from the clip's
stored transcript, and it has a synthetic sound effect and a ducked synthetic music bed, made here.

Checked, for each rate:

- **OTIO**: edit.json → ``.otio`` → edit.json is an empty diff (canonical JSON);
- **cuts**: FCPXML, FCP7 XML and EDL read back at the edit's rate with every video cut on its exact
  frame, the same ``(start, duration, in)`` as the edit and the same source ranges
  (``harness.cut_list_diff``);
- **linked audio**: in the FCPXML every clip's own sound starts on its video's frame (spike B2 had 5
  of 58 a frame early), and the rate is kept;
- **XML**: both XML files are well formed (``xmllint --noout`` when present);
- **captions**: the SRT and ASS beside the files have every chunk the MP4 export burns in, each
  within 1 frame.

No reference file: exact equality with the edit is the expectation. Nothing is rendered.
Run with ``pnpm test:golden -- interchange-otio-fcpxml-edl``.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import opentimelineio as otio
import pysubs2
import pytest

import harness
from export_support import make_edit
from s7engine import fcpx_exact, otio_map
from s7engine.jobs import JobContext
from s7engine.methods import export, interchange

KEEP = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.keep.json"
TRANSCRIPT = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.transcript.json"
CLIP_RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
WIDTH, HEIGHT = 1080, 1920


def _tone(path: Path, source: str, seconds: int) -> Path:
    subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", source, "-t", str(seconds), "-ac", "1", str(path)],
        check=True,
    )
    return path


def _media(entry_id: str, path: Path, frames: int) -> dict[str, Any]:
    return {
        "id": entry_id,
        "kind": "audio",
        "reference": str(path),
        "fingerprint": {"sha256": "0" * 64, "size": path.stat().st_size},
        "probe": {"hasVideo": False, "hasAudio": True, "durationFrames": frames},
    }


def _edit(source: Path, work: Path, rate: Fraction) -> tuple[dict[str, Any], dict[str, Any]]:
    keep = json.loads(KEEP.read_text(encoding="utf-8"))
    scale = rate / CLIP_RATE
    ranges = [(round(start * scale), round(end * scale)) for start, end in keep["keep"]]
    edit = make_edit(source=source, ranges=ranges, fps=rate, duration_frames=round(SOURCE_FRAMES * scale), width=WIDTH, height=HEIGHT)
    edit["media"][0]["probe"].update({"width": 1920, "height": 1080})
    edit["tracks"].append({"kind": "caption", "id": "C1", "style": "s7-neutral", "items": []})
    ding = _tone(work / "ding.wav", "sine=f=1000:sample_rate=8000", 1)
    bed = _tone(work / "bed.wav", "sine=f=220:sample_rate=8000", 20)
    edit["media"] += [_media("ding", ding, math.floor(rate)), _media("bed", bed, math.floor(20 * rate))]
    total = sum(end - start for start, end in ranges)
    sfx = [{"id": f"s{n}", "media": "ding", "start": at, "duration": math.floor(rate) // 2, "in": 0, "gainDb": -9} for n, at in enumerate((48, 400, 900))]
    edit["tracks"].append({"kind": "sfx", "id": "S1", "items": sfx})
    edit["tracks"].append(
        {
            "kind": "music",
            "id": "M1",
            "duck": {"depthDb": -12, "attackFrames": 5, "releaseFrames": 10, "ranges": [{"start": 0, "end": min(total, 300)}]},
            "items": [{"id": "m0", "media": "bed", "start": 0, "duration": min(total, math.floor(20 * rate)), "in": 0, "gainDb": -18, "fadeOutFrames": 24}],
        }
    )
    transcript = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    words = [{key: word[key] for key in ("text", "startFrame", "endFrame")} for word in transcript["words"]]
    return edit, {"transcripts": [{"media": "cam", "fps": transcript["fps"], "words": words}]}


def _cuts(timeline: otio.schema.Timeline, rate: Fraction) -> list[tuple[int, int, int]]:
    track = next(entry for entry in timeline.tracks if entry.kind == otio.schema.TrackKind.Video)

    def frames(time: otio.opentime.RationalTime) -> int:
        value = time.rescaled_to(float(rate)).value
        assert abs(value - round(value)) < 1e-6, value
        return round(value)

    return [
        (frames(track.range_of_child(clip).start_time), frames(clip.source_range.duration), frames(clip.source_range.start_time))
        for clip in track
        if isinstance(clip, otio.schema.Clip)
    ]


def _canonical(document: dict[str, Any]) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def _read(path: str, rate: Fraction) -> otio.schema.Timeline:
    text = Path(path).read_text(encoding="utf-8")
    if path.endswith(".fcpxml"):
        return fcpx_exact.install().read_from_string(text)
    if path.endswith(".xml"):
        return otio.adapters.read_from_string(text, "fcp_xml")
    if path.endswith(".edl"):
        from otio_cmx3600_adapter import cmx_3600

        return cmx_3600.read_from_string(text, rate=float(rate))
    return otio.adapters.read_from_string(text, "otio_json")


@pytest.mark.parametrize("rate", ["24000/1001", "30000/1001"])
def test_interchange_otio_fcpxml_edl(media, tmp_path: Path, rate: str) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not exporting"
    fps = Fraction(rate)
    (tmp_path / "exports").mkdir()
    edit, extra = _edit(source, tmp_path, fps)
    expected = [(item["start"], item["duration"], item["in"]) for item in edit["tracks"][0]["items"]]
    burned = export.export_chunks(edit, export.plan_segments(edit, WIDTH, HEIGHT), extra)
    assert len(burned) > 20, "the transcript captions the cut"

    def run(fmt: str, captions: str) -> dict[str, Any]:
        params = {
            "edit": edit,
            "projectDir": str(tmp_path),
            "outputBase": str(tmp_path / "exports" / f"talking-head-{fmt}-{captions}"),
            "format": fmt,
            "captions": captions,
            **extra,
        }
        return interchange._export(params, JobContext.detached())

    otio_files = run("otio", "srt")["files"]
    assert _canonical(otio_map.from_otio(_read(otio_files[0], fps))) == _canonical(edit)

    for fmt in ("fcpxml", "fcp7xml", "edl"):
        result = run(fmt, "srt")
        timeline = _read(result["files"][0], fps)
        assert _cuts(timeline, fps) == expected, fmt
        diff = harness.cut_list_diff(
            [(start, start + duration) for _, duration, start in expected],
            [(start, start + duration) for _, duration, start in _cuts(timeline, fps)],
        )
        assert diff is None, f"{fmt}: {diff}"
        if fmt != "edl":
            ElementTree.fromstring(Path(result["files"][0]).read_bytes())
            if shutil.which("xmllint") or Path("/usr/bin/xmllint").exists():
                subprocess.run([shutil.which("xmllint") or "/usr/bin/xmllint", "--noout", result["files"][0]], check=True)
        assert "hello" not in Path(result["files"][0]).read_text(encoding="utf-8").lower()

        cues = pysubs2.load(result["files"][1], format_="srt").events
        assert len(cues) == len(burned), fmt
        for cue, chunk in zip(cues, burned):
            assert abs(math.floor(Fraction(cue.start, 1000) * fps) - chunk.start) <= 1
            assert abs(math.floor(Fraction(cue.end, 1000) * fps) - chunk.end) <= 1

    # Linked audio: each clip's own sound on its video's frame, and the rate kept.
    fcpxml = run("fcpxml", "ass")
    spine = ElementTree.fromstring(Path(fcpxml["files"][0]).read_bytes()).find(".//spine")
    shifted = [
        clip.get("name")
        for clip in spine.findall("clip")
        for audio in clip.findall("clip[@lane='-1']")
        if fcpx_exact.parse_time(audio.get("offset")) != fcpx_exact.parse_time(clip.get("start", "0s"))
    ]
    assert len(spine.findall("clip")) == len(expected)
    assert shifted == []
    assert {clip.source_range.duration.rate for clip in _read(fcpxml["files"][0], fps).find_clips()} == {float(fps)}

    # The ASS times are centiseconds just before each frame (captions_ass.frame_to_ms).
    events = pysubs2.load(fcpxml["files"][1]).events
    starts = [math.floor(Fraction(event.start + 10, 1000) * fps) for event in events]
    ends = [math.floor(Fraction(event.end + 10, 1000) * fps) for event in events]
    for chunk in burned:
        assert any(abs(start - chunk.start) <= 1 for start in starts), chunk
        assert any(abs(end - chunk.end) <= 1 for end in ends), chunk
