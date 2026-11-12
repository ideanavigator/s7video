# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``zoom-crop-presets`` (S7V-037): punch-in zooms and caption looks in the export.

**Zoom.** ``talking-head-01`` cut to 4 ranges (240 frames at 24000/1001), exported at 9:16 with
three punch-ins: 1.25 across a cut, 1.5, and 2.0 with a 6-frame ramp. Each sampled zoomed frame
matches its reference, the source frame put through the export's own canvas chain and scaled and
cropped at the rectangle ``zoom.py`` computes, never encoded: SSIM ≥ 0.98, and above the same
rectangle 2 px off either way, so the rectangle is the exact one. (Zooming the unzoomed export's
decoded frame instead would stack that export's compression loss, magnified by the upscale, on
the zoomed export's own: 0.976–0.981 where this reference gives 0.983–0.986, S7V-037.) The frame
before each zoom and the frame after it match the unzoomed export; its first and last frames are
zoomed (the cut list is exact in frames). Each ramp frame matches its own rectangle and frame N
the target's.

**Looks.** A synthetic ``testsrc2`` clip at 9:16, 1:1 and 16:9 with 20 caption chunks of four
long words, in each look: every caption, its box, outline or shadow included, stays inside the
safe zone, each still switches on its own frames (±1), the highlighted look once per word, and
each look's whole ASS file (its style and its events) matches the stored reference, no two looks
alike. Transcript-derived captions on an edit with no caption items switch on the transcript's
word frames (±1) too.

**Previews.** Each look's ``captions.preview`` matches the exported frame of the same sample
caption on the same flat frame, cut and shrunk the same way: SSIM ≥ 0.98.

Record a new reference with ``S7VIDEO_GOLDEN_UPDATE=1`` and say why in the PR. Run with
``pnpm test:golden -- zoom-crop-presets``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import harness
import pytest
from export_support import keep_ranges, make_edit

from s7engine import captions_ass, zoom
from s7engine.jobs import JobContext
from s7engine.methods import captions, export

REFERENCE = Path(__file__).parent / "references" / "zoom-crop-presets.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
MIN_SSIM = 0.98
PRESETS = ["s7-neutral", "s7-box", "s7-karaoke", "s7-minimal"]
CANVASES = [(1080, 1920), (1080, 1080), (1920, 1080)]
TEXT_DIFF = 60

RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
SEGMENTS, TOTAL = 4, 240
W, H = 1080, 1920
#: Timeline ranges (end exclusive) and their punch-in: across a cut, still, and ramped.
ZOOMS = [
    (40, 80, {"scale": 1.25, "anchorX": 0.5, "anchorY": 1 / 3, "rampFrames": 0}),
    (95, 115, {"scale": 1.5, "anchorX": 0.45, "anchorY": 0.3, "rampFrames": 0}),
    (130, 175, {"scale": 2.0, "anchorX": 0.5, "anchorY": 0.35, "rampFrames": 6}),
]

LONG_WORDS = [
    "Extraordinary", "Wikipedia's", "Arbitration", "Committee", "Supercalifragilistic", "Neighbourhood",
    "Understanding", "Photographers", "Microphones", "Interviewing", "Storytelling", "Consistently",
]
CHUNKS, WORD_FRAMES, GAP_FRAMES = 20, 3, 10


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _ffmpeg(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([harness._tool("ffmpeg"), "-v", "error", "-y", *args], check=True, capture_output=True, text=True)


def _frames(video: Path, frames: list[int], out: Path) -> dict[int, Path]:
    """The given frames of ``video`` as RGB PNGs, in one decode."""
    wanted = sorted(set(frames))
    out.mkdir(parents=True, exist_ok=True)
    select = "+".join(f"eq(n\\,{frame})" for frame in wanted)
    _ffmpeg("-i", str(video), "-vf", f"select={select},format=rgb24", "-fps_mode", "passthrough", str(out / "f-%04d.png"))
    return {frame: out / f"f-{index + 1:04d}.png" for index, frame in enumerate(wanted)}


def _source_frames(source: Path, plan: export.Plan, wanted: dict[str, tuple[int, zoom.Crop | None]], out: Path) -> dict[str, Path]:
    """Source frames through the export's own canvas chain, each zoomed at its rectangle (or not),
    never encoded, as RGB PNGs: the zoom's references, from one decode of the source."""
    out.mkdir(parents=True, exist_ok=True)
    names = list(wanted)
    canvas = export._canvas_chain(plan, export._probe_source(str(source), JobContext.detached()))
    chains = [f"[0:v]fps={RATE.numerator}/{RATE.denominator},{canvas},split={len(names)}" + "".join(f"[b{i}]" for i in range(len(names)))]
    outputs: list[str] = []
    for index, name in enumerate(names):
        frame, crop = wanted[name]
        zoomed = "" if crop is None else f"scale={crop.scaled_width}:{crop.scaled_height},crop={W}:{H}:{crop.x}:{crop.y},"
        chains.append(f"[b{index}]select=eq(n\\,{frame}),{zoomed}format=rgb24[o{index}]")
        outputs += ["-map", f"[o{index}]", "-frames:v", "1", str(out / f"{name}.png")]
    _ffmpeg("-i", str(source), "-filter_complex", ";".join(chains), *outputs)
    return {name: out / f"{name}.png" for name in names}


def _source_frame(plan: export.Plan, frame: int) -> int:
    segment = next(s for s in plan.segments if s.timeline_start <= frame < s.timeline_start + s.frames)
    return segment.source_in + frame - segment.timeline_start


def _ssim(a: Path, b: Path, crop: str = "") -> float:
    chain = f"[0]{crop}[x];[1]{crop}[y];[x][y]ssim" if crop else "[0][1]ssim"
    run = subprocess.run(
        [harness._tool("ffmpeg"), "-hide_banner", "-i", str(a), "-i", str(b), "-filter_complex", chain, "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    return float(re.findall(r"All:([0-9.]+)", run.stderr)[-1])


def _frame_count(video: Path) -> int:
    return int(harness.probe_summary(video)["video_frames"])


def _split_and_zoom(edit: dict[str, Any], start: int, end: int, value: dict[str, Any]) -> None:
    """What ``zoomOps`` writes: items split at the range's edges, the covered parts zoomed."""
    track = edit["tracks"][0]
    items: list[dict[str, Any]] = []
    for item in track["items"]:
        cuts = sorted({item["start"], item["start"] + item["duration"], *(f for f in (start, end) if item["start"] < f < item["start"] + item["duration"])})
        for index, (a, b) in enumerate(zip(cuts, cuts[1:])):
            part = {**item, "id": item["id"] if index == 0 else f"{item['id']}z{a}", "start": a, "duration": b - a, "in": item["in"] + a - item["start"]}
            if start <= a and b <= end:
                part["zoom"] = value
            items.append(part)
    track["items"] = items


def _render(edit: dict[str, Any], out: Path, project: Path, burn: bool, transcripts: list[dict[str, Any]] | None = None) -> Path:
    params: dict[str, Any] = {"edit": edit, "projectDir": str(project), "outputPath": str(out), "captions": burn}
    if transcripts is not None:
        params["transcripts"] = transcripts
    export._render(params, JobContext.detached())
    return out


def _reference() -> dict[str, Any]:
    return json.loads(REFERENCE.read_text(encoding="utf-8")) if REFERENCE.exists() else {}


def _record(key: str, observed: Any) -> None:
    """Checks ``observed`` against the stored reference, or stores it with ``S7VIDEO_GOLDEN_UPDATE=1``."""
    stored = _reference()
    if UPDATE:
        stored[key] = observed
        REFERENCE.write_text(json.dumps(stored, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    assert key in stored, f"no stored reference for {key}; record one with S7VIDEO_GOLDEN_UPDATE=1"
    assert observed == stored[key], key


# --- Zoom ----------------------------------------------------------------------------------------


def test_zoom_crops_exactly(media, tmp_path: Path) -> None:
    source = media("talking-head-01")
    edit = make_edit(source=source, ranges=keep_ranges(SOURCE_FRAMES // 4, SEGMENTS, TOTAL), fps=RATE,
                     duration_frames=SOURCE_FRAMES, width=W, height=H)
    plain = _render(edit, tmp_path / "plain.mp4", tmp_path, burn=False)
    for start, end, value in ZOOMS:
        _split_and_zoom(edit, start, end, value)
    zoomed = _render(edit, tmp_path / "zoomed.mp4", tmp_path, burn=False)
    assert _frame_count(zoomed) == _frame_count(plain) == TOTAL

    # Frame → (the zoom nearby, the item's own frame number, whether this frame is zoomed).
    samples: dict[int, tuple[zoom.Zoom, int, bool]] = {}
    for start, end, value in ZOOMS:
        punch = zoom.Zoom(value["scale"], value["anchorX"], value["anchorY"], value["rampFrames"])
        samples[start - 1] = (punch, 0, False)
        samples[end] = (punch, end - start, False)
        for frame in (start, (start + end) // 2, end - 1):
            samples[frame] = (punch, frame - start, True)
        for step in range(punch.ramp_frames + 2):
            samples[start + step] = (punch, step, True)
    shots = {"plain": _frames(plain, list(samples), tmp_path / "plain"), "zoomed": _frames(zoomed, list(samples), tmp_path / "zoomed")}
    plan = export.plan_segments(edit, W, H)
    wanted: dict[str, tuple[int, zoom.Crop | None]] = {}
    for frame, (punch, step, inside) in samples.items():
        # Outside a zoom, the reference it must not match is the zoom's own target rectangle.
        crop = zoom.frame_crop(W, H, punch, step) if inside else zoom.crop_at(W, H, punch.scale, punch.anchor_x, punch.anchor_y)
        wanted[f"ref-{frame}"] = (_source_frame(plan, frame), crop)
        for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2)):
            near = zoom.Crop(crop.scaled_width, crop.scaled_height, crop.x + dx, crop.y + dy)
            if 0 <= near.x <= near.scaled_width - W and 0 <= near.y <= near.scaled_height - H:
                wanted[f"near-{frame}-{dx}-{dy}"] = (_source_frame(plan, frame), near)
    refs = _source_frames(source, plan, wanted, tmp_path / "source")

    rects: list[list[int]] = []
    for frame, (punch, step, inside) in sorted(samples.items()):
        got, unzoomed = shots["zoomed"][frame], shots["plain"][frame]
        if not inside:
            # The frames either side of a zoom are the unzoomed export's, not the zoom's.
            as_plain = _ssim(got, unzoomed)
            as_zoom = _ssim(got, refs[f"ref-{frame}"])
            print(f"zoom-crop-presets frame {frame} (outside x{punch.scale}): SSIM vs unzoomed {as_plain:.4f}, vs zoomed {as_zoom:.4f}")
            assert as_plain >= MIN_SSIM, (frame, as_plain)
            assert as_plain > as_zoom, frame
            continue
        crop = zoom.frame_crop(W, H, punch, step)
        rects.append([frame, crop.scaled_width, crop.scaled_height, crop.x, crop.y])
        exact = _ssim(got, refs[f"ref-{frame}"])
        bare = _ssim(got, unzoomed)
        if (crop.scaled_width, crop.scaled_height) == (W, H):
            # A ramp's first frame is at scale 1: the unzoomed picture, which the plain export shows too.
            print(f"zoom-crop-presets frame {frame} (x{punch.scale}, ramp step 0): unzoomed, SSIM {exact:.4f}, vs the plain export {bare:.4f}")
            assert exact >= MIN_SSIM and bare >= MIN_SSIM, (frame, exact, bare)
            continue
        nears = [_ssim(got, path) for name, path in refs.items() if name.startswith(f"near-{frame}-")]
        print(
            f"zoom-crop-presets frame {frame} (x{punch.scale}, ramp step {min(step, punch.ramp_frames) if punch.ramp_frames else '-'}):"
            f" rect {crop.scaled_width}x{crop.scaled_height}+{crop.x}+{crop.y}, SSIM {exact:.4f},"
            f" 2 px off at most {f'{max(nears):.4f}' if nears else '- (no room)'}, unzoomed {bare:.4f}"
        )
        assert exact >= MIN_SSIM, (frame, exact)
        assert exact > bare, frame
        assert all(exact > near for near in nears), (frame, nears)
    # The ramp reaches the target's own rectangle on frame N, and keeps it.
    ramp_start, _, ramp_value = ZOOMS[2]
    target = zoom.crop_at(W, H, ramp_value["scale"], ramp_value["anchorX"], ramp_value["anchorY"])
    ramped = zoom.Zoom(ramp_value["scale"], ramp_value["anchorX"], ramp_value["anchorY"], ramp_value["rampFrames"])
    assert zoom.frame_crop(W, H, ramped, ramped.ramp_frames) == target != zoom.frame_crop(W, H, ramped, ramped.ramp_frames - 1)
    print(f"zoom-crop-presets: {len(rects)} zoomed frames checked, ramp target {target} from frame {ramp_start + ramped.ramp_frames}")
    _record("zoomRects", rects)


# --- Looks ---------------------------------------------------------------------------------------


def _long_items() -> list[dict[str, Any]]:
    items, at = [], 0
    for index in range(CHUNKS):
        words = [LONG_WORDS[(index + offset) % len(LONG_WORDS)] for offset in range(4)]
        # The last word ends the chunk with a full stop, so each item is one chunk.
        words[-1] += "."
        timed = [{"text": word, "start": at + n * WORD_FRAMES, "duration": WORD_FRAMES} for n, word in enumerate(words)]
        items.append({"id": f"c{index + 1}", "start": at, "duration": 4 * WORD_FRAMES, "text": " ".join(words), "words": timed})
        at += 4 * WORD_FRAMES + GAP_FRAMES
    return items


def _masks(captioned: Path, plain: Path, band: tuple[int, int, int, int]) -> list[frozenset[int]]:
    """Per frame, the band's pixels the captions change, on the blue channel (see the overlay golden)."""
    left, top, right, bottom = band
    size = ((right - left) // 4, (bottom - top) // 4)
    chain = f"crop={right - left}:{bottom - top}:{left}:{top},scale={size[0]}:{size[1]}:flags=area,format=gbrp,extractplanes=b"

    def planes(video: Path) -> list[bytes]:
        raw = subprocess.run([harness._tool("ffmpeg"), "-v", "error", "-i", str(video), "-vf", chain, "-f", "rawvideo", "-"],
                             check=True, capture_output=True).stdout
        step = size[0] * size[1]
        return [raw[index * step : (index + 1) * step] for index in range(len(raw) // step)]

    return [frozenset(i for i, (a, b) in enumerate(zip(x, y)) if abs(a - b) > TEXT_DIFF) for x, y in zip(planes(captioned), planes(plain))]


def _assert_switches(masks: list[frozenset[int]], edges: list[int], total: int) -> dict[str, int]:
    """Each edge switches the captions within one frame; returns how many switched 1 early, on, 1 late."""
    offsets = {"-1": 0, "0": 0, "+1": 0}
    for edge in edges:
        if 0 < edge < total:
            changed = [frame - edge for frame in range(max(1, edge - 1), min(total, edge + 2)) if masks[frame] != masks[frame - 1]]
            assert changed, edge
            offsets[f"{min(changed, key=abs):+d}".replace("+0", "0")] += 1
    return offsets


def _alpha_box(still: Path, width: int) -> tuple[int, int, int, int] | None:
    alpha = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(still), "-vf", "format=rgba,alphaextract,format=gray", "-f", "rawvideo", "-"],
        check=True, capture_output=True,
    ).stdout
    drawn = [i for i, value in enumerate(alpha) if value > 0]
    if not drawn:
        return None
    xs, ys = [i % width for i in drawn], [i // width for i in drawn]
    return (min(xs), min(ys), max(xs), max(ys))


@pytest.mark.parametrize(("width", "height"), CANVASES)
def test_every_look_stays_in_the_safe_zone_and_on_its_frames(synth_clip, tmp_path: Path, width: int, height: int) -> None:
    total = CHUNKS * (4 * WORD_FRAMES + GAP_FRAMES)
    source = synth_clip({"name": f"zoom-presets-{width}x{height}", "fps": "30/1", "width": width, "height": height,
                         "audio": [{"seconds": total / 30 + 1, "toneHz": 440}]})
    edit = make_edit(source=source, ranges=[(0, total)], fps=Fraction(30), duration_frames=total + 30, width=width, height=height,
                     captions=_long_items())
    plain = _render(edit, tmp_path / "plain.mp4", tmp_path, burn=False)
    observed = {}
    for style in PRESETS:
        edit["tracks"][1]["style"] = style
        chunks = captions.chunks_of(edit)
        cues = captions_ass.cues(chunks, style)
        assert len(chunks) == CHUNKS
        assert len(cues) == (4 * CHUNKS if style == "s7-karaoke" else CHUNKS)
        # The whole ASS file: the look's style (font, size, colours, box, outline, shadow, margins)
        # as well as its events, so a change to either is a change to the reference.
        ass = captions_ass.build_cues(cues, Fraction(30), width, height, style)
        observed[style] = {"events": len(ass.events), "sha256": hashlib.sha256(ass.to_string("ass").encode()).hexdigest()}
        layout = captions_ass.layout_for(width, height, captions_ass.load_style(style))
        left, top, right, bottom = layout.safe
        # Every still the export's own ASS draws, box, outline and shadow included, is in the zone.
        stills = captions._render({"edit": edit, "cacheDir": str(tmp_path / "stills")}, JobContext.detached())
        boxes = []
        for name in {chunk["png"] for chunk in stills["chunks"]}:
            box = _alpha_box(tmp_path / "stills" / stills["folder"] / name, width)
            assert box is not None, (style, name)
            assert left <= box[0] and box[2] < right and top <= box[1] and box[3] < bottom, (style, box, layout.safe)
            boxes.append(box)
        # The union of every caption's pixels, and the zone it must stay in.
        union = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
        observed[style]["captionBox"] = union
        observed[style]["safeZone"] = list(layout.safe)
        captioned = _render(edit, tmp_path / f"{style}.mp4", tmp_path, burn=True)
        # Each still switches on its own frames: a chunk's, or a word's in the highlighted look.
        masks = _masks(captioned, plain, (left, top, right, bottom))
        offsets = _assert_switches(masks, sorted({edge for cue in cues for edge in (cue.start, cue.end)}), total)
        print(f"zoom-crop-presets {width}x{height} {style}: {len(cues)} stills, caption box {union} in safe zone {list(layout.safe)}, switches (1 early / on / 1 late) {offsets}")
        captioned.unlink()
    # Each look is its own file: no two looks may share a hash on a canvas.
    assert len({look["sha256"] for look in observed.values()}) == len(PRESETS), observed
    _record(f"looks-{width}x{height}", observed)


def test_transcript_captions_switch_on_the_word_frames(synth_clip, tmp_path: Path) -> None:
    total = 240
    source = synth_clip({"name": "zoom-presets-1080x1920", "fps": "30/1", "width": W, "height": H,
                         "audio": [{"seconds": CHUNKS * (4 * WORD_FRAMES + GAP_FRAMES) / 30 + 1, "toneHz": 440}]})
    edit = make_edit(source=source, ranges=[(0, total)], fps=Fraction(30), duration_frames=total + 30, width=W, height=H)
    words, at = [], 3
    for index in range(16):
        words.append({"text": LONG_WORDS[index % len(LONG_WORDS)] + ("." if index % 4 == 3 else ""), "startFrame": at, "endFrame": at + 7})
        at += 8 if index % 4 != 3 else 20
    transcript = {"media": "cam", "fps": {"num": 30, "den": 1}, "words": words}
    # The transcript caption track before its first rebuild: empty, but it names the look.
    edit["tracks"].append({"kind": "caption", "id": "C1", "style": "s7-karaoke", "items": [], "metadata": {"s7": {"source": "transcript"}}})
    plan = export.plan_segments(edit, W, H)
    cues = captions_ass.cues(export.export_chunks(edit, plan, {"transcripts": [transcript]}), "s7-karaoke")
    # Every word state starts on its word's own frame (the first word of each chunk too).
    assert [cue.start for cue in cues] == [word["startFrame"] for word in words]
    captioned = _render(edit, tmp_path / "captioned.mp4", tmp_path, burn=True, transcripts=[transcript])
    plain = _render(edit, tmp_path / "plain.mp4", tmp_path, burn=False)
    safe = captions_ass.layout_for(W, H, captions_ass.load_style("s7-karaoke")).safe
    offsets = _assert_switches(_masks(captioned, plain, safe), sorted({edge for cue in cues for edge in (cue.start, cue.end)}), total)
    print(f"zoom-crop-presets transcript captions, s7-karaoke: {len(cues)} word states on the word frames, switches (1 early / on / 1 late) {offsets}")
    _record("transcriptWordStarts", [cue.start for cue in cues])


# --- Previews ------------------------------------------------------------------------------------


@pytest.mark.parametrize("style", PRESETS)
def test_preview_matches_the_exported_frame(tmp_path: Path, style: str) -> None:
    flat = tmp_path / "flat.mp4"
    _ffmpeg("-f", "lavfi", "-i", f"color=c={captions.PREVIEW_BACKGROUND}:s={W}x{H}:r=30:d=2", "-f", "lavfi", "-i",
            "anullsrc=r=48000:cl=stereo", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(flat))
    # The sample caption, its words timed so frame 30 shows the preview's lit word.
    words = [{"text": word, "start": 10 * index, "duration": 10} for index, word in enumerate(captions.PREVIEW_WORDS)]
    item = {"id": "c1", "start": 0, "duration": 30 + 10, "text": " ".join(captions.PREVIEW_WORDS), "words": words}
    words[-1]["duration"] = 20
    edit = make_edit(source=flat, ranges=[(0, 60)], fps=Fraction(30), duration_frames=60, width=W, height=H, captions=[item])
    edit["tracks"][1]["style"] = style
    lit_frame = 10 * captions.PREVIEW_LIT + 5
    exported = _frames(_render(edit, tmp_path / "out.mp4", tmp_path, burn=True), [lit_frame], tmp_path / "frames")[lit_frame]
    preview = captions._preview({"preset": style, "width": W, "height": H, "cacheDir": str(tmp_path / "cache")}, JobContext.detached())
    drawn = tmp_path / "cache" / preview["folder"] / preview["png"]
    left, top, right, bottom = captions.preview_band(W, H, style)
    shrunk = tmp_path / "shrunk.png"
    _ffmpeg("-i", str(exported), "-vf", f"crop={right - left}:{bottom - top}:{left}:{top},scale={captions.PREVIEW_WIDTH}:-2:flags=area,format=rgb24", str(shrunk))
    score = _ssim(drawn, shrunk)
    print(f"zoom-crop-presets preview {style}: SSIM {score:.4f}")
    assert score >= MIN_SSIM, score
