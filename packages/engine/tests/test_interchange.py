# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Export for editors (S7V-040): the OTIO map, the FCPXML fix, the captions file and the job.

Media files here are empty placeholders: nothing is probed or decoded, only referenced.
"""

from __future__ import annotations

import json
import math
import os
import random
import subprocess
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import opentimelineio as otio
import pytest

from s7engine import captions_ass, fcpx_exact, otio_map
from s7engine.jobs import Cancelled, JobContext
from s7engine.methods import export, interchange
from s7engine.rpc import RpcError

RATES = [Fraction(25), Fraction(30), Fraction(30000, 1001), Fraction(24000, 1001)]


def canonical(document: dict[str, Any]) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def media(entry_id: str, kind: str, *, path: str | None = None, reference: str | None = None, **probe: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": entry_id,
        "kind": kind,
        "fingerprint": {"sha256": "0" * 64, "size": 1},
        "probe": {"hasVideo": kind != "audio", "hasAudio": kind != "image", **probe},
    }
    if path is not None:
        entry["path"] = path
    if reference is not None:
        entry["reference"] = reference
    return entry


def placeholders(project: Path, edit: dict[str, Any]) -> None:
    for entry in edit["media"]:
        file = Path(entry["reference"]) if "reference" in entry else project / entry["path"]
        file.parent.mkdir(parents=True, exist_ok=True)
        file.touch()


def full_edit(project: Path, rate: Fraction, width: int = 1080, height: int = 1920) -> dict[str, Any]:
    """Every v1 field: captions with words, SFX, ducked music, zoom, overlays, markers, links."""
    edit = {
        "version": 1,
        "fps": {"num": rate.numerator, "den": rate.denominator},
        "canvas": {"width": width, "height": height},
        "media": [
            media("cam", "video", path="assets/cam.mp4", durationFrames=900, width=1920, height=1080, fps={"num": 25, "den": 1}),
            media("ding", "audio", reference=str(project.parent / "sounds" / "ding.wav"), durationFrames=30, sampleRate=48000),
            media("bed", "audio", path="assets/bed.wav", durationFrames=900),
            media("logo", "image", path="assets/logo.png", width=200, height=200),
        ],
        "tracks": [
            {
                "kind": "video",
                "id": "V1",
                "role": "main",
                "label": "Camera",
                "metadata": {"note": "first"},
                # Out of time order on purpose: the round trip keeps the array order.
                "items": [
                    {"id": "b", "media": "cam", "start": 52, "duration": 33, "in": 120, "gainDb": -3, "muted": True, "linkId": "L1"},
                    {
                        "id": "a",
                        "media": "cam",
                        "start": 0,
                        "duration": 40,
                        "in": 10,
                        "zoom": {"scale": 1.25, "anchorX": 0.5, "anchorY": 0.33, "rampFrames": 6},
                        "label": "intro",
                        "metadata": {"take": 2},
                    },
                ],
            },
            {
                "kind": "caption",
                "id": "C1",
                "style": "s7-neutral",
                "items": [
                    {
                        "id": "c0",
                        "start": 2,
                        "duration": 20,
                        "text": "hello there",
                        "words": [{"text": "hello", "start": 2, "duration": 8}, {"text": "there", "start": 10, "duration": 12}],
                    },
                    {"id": "c1", "start": 55, "duration": 12, "text": "again {really}", "style": "s7-neutral"},
                ],
            },
            {"kind": "sfx", "id": "S1", "items": [{"id": "s0", "media": "ding", "start": 30, "duration": 20, "in": 0, "gainDb": -9, "linkId": "L1"}]},
            {
                "kind": "music",
                "id": "M1",
                "duck": {"depthDb": -12, "attackFrames": 5, "releaseFrames": 10, "ranges": [{"start": 0, "end": 50}]},
                "items": [{"id": "m0", "media": "bed", "start": 0, "duration": 85, "in": 0, "gainDb": -18, "fadeInFrames": 4, "fadeOutFrames": 10}],
            },
            {
                "kind": "overlay",
                "id": "O1",
                "items": [
                    {"id": "o0", "text": "Subscribe", "start": 5, "duration": 20, "transform": {"x": 0.5, "y": 0.2, "scale": 1, "rotationDeg": 0}},
                    {"id": "o1", "media": "logo", "start": 30, "duration": 10, "opacity": 0.8},
                ],
            },
            {"kind": "sfx", "id": "S2", "muted": True, "items": []},
        ],
        "markers": [
            {"id": "k1", "start": 60, "duration": 0, "label": "look here", "color": "red"},
            {"id": "k2", "start": 3, "duration": 2, "label": "x"},
            {"id": "k3", "start": 44, "duration": 1, "label": "gap"},
        ],
        "metadata": {"source": "test", "nested": {"list": [1, 2.5, None, True]}},
    }
    placeholders(project, edit)
    return edit


def simple_edit(project: Path, rate: Fraction, items: list[tuple[int, int, int]], **extra: Any) -> dict[str, Any]:
    edit = {
        "version": 1,
        "fps": {"num": rate.numerator, "den": rate.denominator},
        "canvas": {"width": 1920, "height": 1080},
        "media": [media("cam", "video", path="assets/cam.mp4", durationFrames=100_000, width=1920, height=1080)],
        "tracks": [
            {"kind": "video", "id": "V1", "items": [{"id": f"v{n}", "media": "cam", "start": s, "duration": d, "in": i} for n, (s, d, i) in enumerate(items)]}
        ],
        "markers": [],
        "metadata": {},
        **extra,
    }
    placeholders(project, edit)
    return edit


def irregular_cuts(count: int = 58, seed: int = 7) -> list[tuple[int, int, int]]:
    """``count`` silence-cut style items: back to back on the timeline, skipping through the source."""
    rng = random.Random(seed)
    items, at, source = [], 0, 3
    for _ in range(count):
        length = rng.randint(7, 61)
        source += rng.randint(1, 23)
        items.append((at, length, source))
        at += length
        source += length
    return items


def run_export(project: Path, edit: dict[str, Any], fmt: str, captions: str = "srt", job: JobContext | None = None, **extra: Any) -> dict[str, Any]:
    exports = project / "exports"
    exports.mkdir(exist_ok=True)
    params = {"edit": edit, "projectDir": str(project), "outputBase": str(exports / f"cut-{fmt}"), "format": fmt, "captions": captions, **extra}
    return interchange._export(params, job or JobContext.detached())


def read_back(path: str, rate: Fraction) -> otio.schema.Timeline:
    text = Path(path).read_text(encoding="utf-8")
    if path.endswith(".fcpxml"):
        return fcpx_exact.install().read_from_string(text)
    if path.endswith(".xml"):
        return otio.adapters.read_from_string(text, "fcp_xml")
    if path.endswith(".edl"):
        from otio_cmx3600_adapter import cmx_3600

        return cmx_3600.read_from_string(text, rate=float(rate))
    return otio.adapters.read_from_string(text, "otio_json")


def cut_list(timeline: otio.schema.Timeline, rate: Fraction, kind: str = otio.schema.TrackKind.Video, index: int = 0) -> list[tuple[int, int, int]]:
    """``(start, duration, in)`` in frames of every clip on a track, read back at the edit's rate."""
    track = [entry for entry in timeline.tracks if entry.kind == kind][index]

    def frames(time: otio.opentime.RationalTime) -> int:
        value = time.rescaled_to(float(rate)).value
        assert abs(value - round(value)) < 1e-6, value
        return round(value)

    return [
        (frames(track.range_of_child(clip).start_time), frames(clip.source_range.duration), frames(clip.source_range.start_time))
        for clip in track
        if isinstance(clip, otio.schema.Clip)
    ]


def xml_root(path: str) -> ElementTree.Element:
    return ElementTree.fromstring(Path(path).read_bytes())


# --- Tier 1 ------------------------------------------------------------------------------------


@pytest.mark.parametrize("rate", RATES, ids=str)
def test_roundtrip_edit_otio_edit_is_empty_diff(tmp_path: Path, rate: Fraction) -> None:
    edit = full_edit(tmp_path, rate)
    result = run_export(tmp_path, edit, "otio")
    back = otio_map.from_otio(read_back(result["files"][0], rate))
    assert canonical(back) == canonical(edit), "the file keeps everything for s7video"


def test_otio_not_carried_lists_zoom_volume_duck_and_caption_look(tmp_path: Path) -> None:
    """S7V-097: Premiere and Resolve don't read ``metadata["s7video"]``, so what lives only there is listed."""
    edit = full_edit(tmp_path, Fraction(25))
    assert run_export(tmp_path, edit, "otio")["dropped"] == [
        "volume changes and fades",
        "music dipping under speech (ducking)",
        "zooms",
        "how overlays sit over the video, and the words of text overlays",
        "the frame shape (1080×1920): the editor opens its own default size",
        "fitting each clip to the frame (fill and crop)",
        "the words on the timeline's caption clips (the captions file beside it has them)",
        "the caption look (an SRT file has no style; choose ASS to keep it)",
    ]
    dropped = interchange._check({"edit": edit, "projectDir": str(tmp_path), "format": "otio", "captions": "none"}, JobContext.detached())["dropped"]
    assert "the words on the timeline's caption clips (no captions file chosen)" in dropped
    assert not any(entry.startswith("the caption look") for entry in dropped)


def test_otio_not_carried_is_empty_for_a_plain_cut(tmp_path: Path) -> None:
    edit = simple_edit(tmp_path, Fraction(25), [(0, 40, 10), (40, 30, 90)])
    edit["markers"] = [{"id": "k1", "start": 3, "duration": 0, "label": "look here", "color": "red"}]
    assert run_export(tmp_path, edit, "otio", captions="none")["dropped"] == []


@pytest.mark.parametrize("rate", [Fraction(25), Fraction(30), Fraction(30000, 1001)], ids=str)
def test_rational_time_from_frames(tmp_path: Path, rate: Fraction) -> None:
    edit = simple_edit(tmp_path, rate, [(0, 40, 10), (40, 33, 90)])
    track = otio_map.to_otio(edit, str(tmp_path), "t").tracks[0]
    clips = [child for child in track if isinstance(child, otio.schema.Clip)]
    assert [(clip.source_range.start_time.value, clip.source_range.duration.value) for clip in clips] == [(10, 40), (90, 33)]
    assert {clip.source_range.duration.rate for clip in clips} == {float(rate)}
    assert fcpx_exact.exact_rate(clips[0].source_range.duration.rate) == rate


@pytest.mark.parametrize("fmt", ["fcpxml", "fcp7xml", "edl"])
def test_caption_track_stripped_for_xml(tmp_path: Path, fmt: str) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    timeline = otio_map.for_editor(edit, str(tmp_path), "t", fmt)
    references = [clip.media_reference for clip in timeline.find_clips()]
    assert not any(isinstance(reference, otio.schema.GeneratorReference) for reference in references)
    result = run_export(tmp_path, edit, fmt)
    assert "hello there" not in Path(result["files"][0]).read_text(encoding="utf-8")
    assert result["files"][1].endswith(".srt")


def test_markers_moved_onto_clips(tmp_path: Path) -> None:
    rate = Fraction(25)
    edit = full_edit(tmp_path, rate)
    result = run_export(tmp_path, edit, "fcpxml")
    markers = {
        marker.get("value"): (marker.get("start"), marker.get("completed"))
        for marker in xml_root(result["files"][0]).iter("marker")
    }
    # Each lands on the clip under it, in that clip's source time; red is not a to-do there.
    assert markers == {"x": ("13/25s", None), "look here": (fcpx_exact.format_time(Fraction(120 + 60 - 52, 25)), None)}
    assert "1 marker on a gap with no clip under it" in result["dropped"]
    assert "marker colours" in result["dropped"]


@pytest.mark.parametrize("rate", [Fraction(25), Fraction(30000, 1001), Fraction(24000, 1001)], ids=str)
def test_fcpx_exact_keeps_linked_audio(tmp_path: Path, rate: Fraction) -> None:
    items = irregular_cuts()
    edit = simple_edit(tmp_path, rate, items)
    result = run_export(tmp_path, edit, "fcpxml")
    spine = xml_root(result["files"][0]).find(".//spine")
    pairs = [
        (fcpx_exact.parse_time(clip.get("start", "0s")), fcpx_exact.parse_time(audio.get("offset")))
        for clip in spine.findall("clip")
        for audio in clip.findall("clip[@lane='-1']")
    ]
    assert len(pairs) == 58
    assert len(xml_root(result["files"][0]).findall(".//asset-clip")) == 1, "one browser clip per file"
    assert [start for start, _ in pairs] == [offset for _, offset in pairs], "linked audio on its video's frame"
    back = read_back(result["files"][0], rate)
    assert cut_list(back, rate) == items, "0 read-back misreads"
    assert {clip.source_range.duration.rate for clip in back.find_clips()} == {float(rate)}


def test_fcpx_exact_guards_the_adapter_version(monkeypatch: pytest.MonkeyPatch) -> None:
    from importlib import metadata

    assert metadata.version(fcpx_exact.ADAPTER) == "1.0.0"
    monkeypatch.setattr(fcpx_exact.metadata, "version", lambda _name: "1.0.1")
    with pytest.raises(RuntimeError, match="re-check fcpx_exact"):
        fcpx_exact.install()


@pytest.mark.parametrize("rate", [Fraction(25), Fraction(30000, 1001)], ids=str)
def test_srt_matches_burned_chunks(tmp_path: Path, rate: Fraction) -> None:
    import pysubs2

    edit = full_edit(tmp_path, rate)
    for track in edit["tracks"]:
        if track["kind"] == "overlay":
            track["items"] = []
    burned = export.export_chunks(edit, export.plan_segments(edit, 1080, 1920), {})
    result = run_export(tmp_path, edit, "fcpxml")
    cues = pysubs2.load(result["files"][1], format_="srt").events
    assert [cue.text for cue in cues] == [chunk.text.replace("{", "(").replace("}", ")") for chunk in burned]
    for cue, chunk in zip(cues, burned):
        # Read back at the edit's rate, as an editor does: the frame the cue time falls in.
        assert math.floor(Fraction(cue.start, 1000) * rate) == chunk.start
        assert math.floor(Fraction(cue.end, 1000) * rate) == chunk.end


# --- Tier 2 ------------------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", otio_map.FORMATS)
@pytest.mark.parametrize("tracks", ["none", "empty-video"])
def test_empty_edit_refused(tmp_path: Path, fmt: str, tracks: str) -> None:
    edit = simple_edit(tmp_path, Fraction(25), [])
    if tracks == "none":
        edit["tracks"] = []
    with pytest.raises(RpcError, match="^the edit has no video to export$"):
        interchange._check({"edit": edit, "projectDir": str(tmp_path), "format": fmt}, JobContext.detached())
    with pytest.raises(RpcError, match="^the edit has no video to export$"):
        run_export(tmp_path, edit, fmt)
    assert list((tmp_path / "exports").iterdir()) == []


def test_edl_with_several_video_tracks(tmp_path: Path) -> None:
    rate = Fraction(25)
    edit = simple_edit(tmp_path, rate, [(0, 40, 10), (50, 30, 200)])
    edit["tracks"].append({"kind": "video", "id": "V2", "items": [{"id": "w", "media": "cam", "start": 5, "duration": 10, "in": 0}]})
    result = run_export(tmp_path, edit, "edl")
    back = read_back(result["files"][0], rate)
    assert cut_list(back, rate) == [(0, 40, 10), (50, 30, 200)]
    assert "video tracks after the first (an EDL has one)" in result["dropped"]
    xml = run_export(tmp_path, edit, "fcp7xml")
    assert cut_list(read_back(xml["files"][0], rate), rate, index=1) == [(5, 10, 0)], "XML keeps the second track"


@pytest.mark.parametrize("rate", [Fraction(25), Fraction(30)], ids=str)
@pytest.mark.parametrize("fmt", ["fcpxml", "fcp7xml", "edl"])
def test_whole_rate_cuts_read_back_exactly(tmp_path: Path, rate: Fraction, fmt: str) -> None:
    items = irregular_cuts()
    result = run_export(tmp_path, simple_edit(tmp_path, rate, items), fmt)
    assert cut_list(read_back(result["files"][0], rate), rate) == items


def edl_markers(path: str, rate: Fraction) -> list[tuple[str, int]]:
    track = read_back(path, rate).tracks[0]
    return [
        (marker.name, round(marker.marked_range.start_time.rescaled_to(float(rate)).value))
        for clip in track
        if isinstance(clip, otio.schema.Clip)
        for marker in clip.markers
    ]


def test_edl_markers_read_back_at_whole_rates_but_not_drop_frame(tmp_path: Path) -> None:
    whole = simple_edit(tmp_path, Fraction(25), [(0, 40, 10), (40, 33, 90)])
    whole["markers"] = [{"id": "k", "start": 45, "duration": 0, "label": "look", "color": "red"}]
    result = run_export(tmp_path, whole, "edl")
    assert "* LOC: 00:00:03:20 PURPLE  LOOK" in Path(result["files"][0]).read_text()
    # On its clip, in the clip's source frames (90 + 45 - 40).
    assert edl_markers(result["files"][0], Fraction(25)) == [("LOOK", 95)]

    ntsc = Fraction(30000, 1001)
    (tmp_path / "ntsc").mkdir()
    drop = simple_edit(tmp_path / "ntsc", ntsc, [(0, 40, 10), (40, 33, 90)])
    drop["markers"] = whole["markers"]
    text = Path(run_export(tmp_path / "ntsc", drop, "edl")["files"][0])
    assert "* LOC: 00:00:03;05 PURPLE  LOOK" in text.read_text()
    # A known OTIO reader limit (docs/internals/pro-export.md): it parses `LOC` only with `:`.
    assert edl_markers(str(text), ntsc) == []
    assert cut_list(read_back(str(text), ntsc), ntsc) == [(0, 40, 10), (40, 33, 90)]


def test_drop_frame_rate_29_97(tmp_path: Path) -> None:
    rate = Fraction(30000, 1001)
    items = irregular_cuts(30, seed=3)
    edit = simple_edit(tmp_path, rate, items)
    result = run_export(tmp_path, edit, "edl")
    events = [line for line in Path(result["files"][0]).read_text().splitlines() if line[:3].isdigit()]
    assert len(events) == 30 and all(";" in line for line in events), "drop-frame timecode"
    assert cut_list(read_back(result["files"][0], rate), rate) == items


@pytest.mark.parametrize(("rate", "duration"), [(Fraction(24000, 1001), "1001/24000s"), (Fraction(30000, 1001), "1001/30000s")], ids=str)
def test_fcpx_ntsc_frame_duration(tmp_path: Path, rate: Fraction, duration: str) -> None:
    assert fcpx_exact.frame_duration(float(rate)) == duration
    result = run_export(tmp_path, simple_edit(tmp_path, rate, [(0, 40, 10)]), "fcpxml")
    assert {fmt.get("frameDuration") for fmt in xml_root(result["files"][0]).iter("format")} == {duration}


def test_fcpx_vertical_format(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def no_subprocess(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the FCPXML export runs no subprocess")

    monkeypatch.setattr(subprocess, "check_output", no_subprocess)
    edit = simple_edit(tmp_path, Fraction(25), [(0, 40, 10)])
    edit["canvas"] = {"width": 1080, "height": 1920}
    result = run_export(tmp_path, edit, "fcpxml")
    for fmt in xml_root(result["files"][0]).iter("format"):
        assert fmt.get("name") == "" and fmt.get("width") is None, "never named as landscape (PO: shape not carried)"
    assert "the frame shape (1080×1920): the editor opens its own default size" in result["dropped"]
    assert "fitting each clip to the frame (fill and crop)" in result["dropped"]


@pytest.mark.parametrize("fmt", ["fcpxml", "fcp7xml", "edl"])
def test_overlay_tracks_stripped_for_xml(tmp_path: Path, fmt: str) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    result = run_export(tmp_path, edit, fmt)
    text = Path(result["files"][0]).read_text(encoding="utf-8")
    assert "Subscribe" not in text and "logo" not in text
    assert "overlays (text and pictures over the video)" in result["dropped"]


@pytest.mark.parametrize("fmt", ["otio", "fcpxml", "fcp7xml"])
def test_media_with_unicode_path(tmp_path: Path, fmt: str) -> None:
    rate = Fraction(25)
    project = tmp_path / "Café's <reel> & more"
    edit = simple_edit(project, rate, [(0, 40, 10)])
    edit["media"][0]["path"] = "assets/naïve 'take' #1 [é].mp4"
    placeholders(project, edit)
    result = run_export(project, edit, fmt)
    if fmt != "otio":
        xml_root(result["files"][0])
        if Path("/usr/bin/xmllint").exists():
            subprocess.run(["/usr/bin/xmllint", "--noout", result["files"][0]], check=True)
    back = read_back(result["files"][0], rate)
    urls = {clip.media_reference.target_url for clip in back.find_clips()}
    assert {otio_map.url_path(url) for url in urls} == {os.path.realpath(project / edit["media"][0]["path"])}
    assert not any("missing media" in entry for entry in result["dropped"])


def test_missing_media_reference(tmp_path: Path) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    os.remove(tmp_path / "assets" / "bed.wav")
    edit["media"][2]["label"] = "Calm bed"
    result = run_export(tmp_path, edit, "fcpxml")
    assert all(os.path.isfile(path) for path in result["files"])
    assert "missing media: Calm bed (the file is not on disk)" in result["dropped"]
    assert str(tmp_path) not in " ".join(result["dropped"]), "no paths in what reaches the agent"


@pytest.mark.parametrize("stage", ["plan", "timeline", "captions"])
def test_cancel_mid_export(tmp_path: Path, stage: str) -> None:
    job: JobContext

    def progress(value: float, at: str | None) -> None:
        if at == stage:
            job.cancel()

    job = JobContext("job-1", progress)
    edit = full_edit(tmp_path, Fraction(25))
    with pytest.raises(Cancelled):
        run_export(tmp_path, edit, "fcpxml", job=job)
    # As the engine does for a job that ends in an error (rpc.Server._run).
    job.discard_outputs()
    assert list((tmp_path / "exports").iterdir()) == []


def test_export_never_writes_outside_exports(tmp_path: Path) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    before = sorted(str(path) for path in tmp_path.rglob("*") if "exports" not in path.parts)
    files = {fmt: run_export(tmp_path, edit, fmt, captions="ass")["files"] for fmt in otio_map.FORMATS}
    after = sorted(str(path) for path in tmp_path.rglob("*") if "exports" not in path.parts)
    assert after == before
    text = Path(files["otio"][0]).read_text()
    assert ".s7cache" not in text and "assets/cam.mp4" in text


def test_transcript_captions_without_caption_items(tmp_path: Path) -> None:
    import pysubs2

    rate = Fraction(25)
    edit = simple_edit(tmp_path, rate, [(0, 40, 10), (40, 30, 90)])
    edit["media"][0]["probe"]["hasAudio"] = True
    transcripts = [
        {
            "media": "cam",
            "fps": {"num": 25, "den": 1},
            "words": [{"text": word, "startFrame": start, "endFrame": start + 6} for word, start in (("one", 12), ("two", 20), ("cut", 60), ("three", 95), ("four", 104))],
        }
    ]
    plan = export.plan_segments(edit, 1920, 1080)
    burned = export.export_chunks(edit, plan, {"transcripts": transcripts})
    assert burned, "the transcript gives captions"
    check = interchange._check({"edit": edit, "projectDir": str(tmp_path), "format": "fcpxml", "transcripts": transcripts}, JobContext.detached())
    assert check["captions"] == len(burned)
    # No caption clips on the OTIO timeline: the captions are only in the file beside it.
    otio_check = interchange._check({"edit": edit, "projectDir": str(tmp_path), "format": "otio", "transcripts": transcripts}, JobContext.detached())
    assert otio_check["dropped"] == ["the caption look (an SRT file has no style; choose ASS to keep it)"]
    result = run_export(tmp_path, edit, "fcpxml", transcripts=transcripts)
    cues = pysubs2.load(result["files"][1], format_="srt").events
    assert [(math.floor(Fraction(cue.start, 1000) * rate), math.floor(Fraction(cue.end, 1000) * rate)) for cue in cues] == [
        (chunk.start, chunk.end) for chunk in burned
    ]


def test_ass_sidecar_keeps_the_look_within_a_frame(tmp_path: Path) -> None:
    import pysubs2

    rate = Fraction(30000, 1001)
    edit = full_edit(tmp_path, rate)
    edit["tracks"][1]["style"] = "s7-bold-pop" if "s7-bold-pop" in captions_ass.presets() else captions_ass.presets()[-1]
    result = run_export(tmp_path, edit, "fcp7xml", captions="ass")
    assert result["files"][1].endswith(".ass")
    subs = pysubs2.load(result["files"][1])
    assert subs.info["PlayResY"] == "1920"
    expected = captions_ass.build_ass(
        export.export_chunks(edit, export.timeline_plan(edit, 1080, 1920), {}), rate, 1080, 1920, export.caption_style(edit)
    )
    assert [(event.start, event.end) for event in subs.events] == [(event.start, event.end) for event in expected.events]
    assert all(abs(event.start - float(Fraction(round(event.start * rate / 1000)) / rate * 1000)) < 1000 / rate for event in subs.events)
    assert "the caption font, Inter Bold, is named in the ASS file but not included" in result["dropped"]


def test_muted_caption_track_writes_no_captions_file(tmp_path: Path) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    edit["tracks"][1]["muted"] = True
    result = run_export(tmp_path, edit, "edl")
    assert len(result["files"]) == 1 and result["captions"] == 0
    assert "no captions file: the edit shows no captions" in result["dropped"]


def test_edl_carries_no_sound_and_says_so(tmp_path: Path) -> None:
    rate = Fraction(25)
    edit = full_edit(tmp_path, rate)
    result = run_export(tmp_path, edit, "edl")
    back = read_back(result["files"][0], rate)
    assert [track.kind for track in back.tracks] == [otio.schema.TrackKind.Video]
    assert any(entry.startswith("all sound") for entry in result["dropped"])


def test_xml_carries_sound_tracks_and_source_audio(tmp_path: Path) -> None:
    rate = Fraction(25)
    edit = full_edit(tmp_path, rate)
    back = read_back(run_export(tmp_path, edit, "fcp7xml")["files"][0], rate)
    audio = [cut_list(back, rate, otio.schema.TrackKind.Audio, index) for index in range(3)]
    # The muted clip "b" has no sound on the timeline, as in the MP4; S1 and M1 keep their places.
    assert audio == [[(0, 40, 10)], [(30, 20, 0)], [(0, 85, 0)]]


def test_check_and_export_list_the_same(tmp_path: Path) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    for fmt in otio_map.FORMATS:
        check = interchange._check({"edit": edit, "projectDir": str(tmp_path), "format": fmt, "captions": "srt"}, JobContext.detached())
        assert check["dropped"] == run_export(tmp_path, edit, fmt)["dropped"]
    assert "volume changes and fades" in check["dropped"] and "zooms" in check["dropped"]
    assert "music dipping under speech (ducking)" in check["dropped"]


def test_a_second_export_never_overwrites(tmp_path: Path) -> None:
    edit = full_edit(tmp_path, Fraction(25))
    run_export(tmp_path, edit, "edl")
    with pytest.raises(RpcError, match="already exists"):
        run_export(tmp_path, edit, "edl")


def test_engine_starts_without_opentimelineio() -> None:
    code = "import sys, s7engine.methods as m; m.all_methods(); print('opentimelineio' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
