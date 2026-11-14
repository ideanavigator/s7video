# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``caption-overlay-parity`` (S7V-075, every look since S7V-037): the player's caption
still, laid over the video, looks like the exported frame with the captions burned in.

``talking-head-01`` cut to 4 ranges (240 frames at 24000/1001), captioned from its stored
transcript as "add captions" does, in each of our four looks, exported at 9:16, 1:1 and 16:9
with and without captions. For the middle frame of each still (a chunk, or in the highlighted
look one word being said), the still from ``captions.render`` is composited (straight alpha, as
the browser draws an ``<img>``) on the uncaptioned export's frame and compared with the captioned
export's frame in the caption band (the safe zone's bottom third): SSIM ≥ 0.98. Each still's
first and last frames in the export match its start and end (±1), the times the overlay switches
on; the switch is read on the blue channel, where the highlighted word differs from white text.

Run with ``pnpm test:golden -- caption-overlay-parity``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from fractions import Fraction
from pathlib import Path

import harness
import pytest
from caption_track_export_golden import track_items
from export_support import keep_ranges, make_edit

from s7engine import captions_ass
from s7engine.jobs import JobContext
from s7engine.methods import captions, export

TRANSCRIPT = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.transcript.json"
RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
SEGMENTS, TOTAL = 4, 240
MIN_SSIM = 0.98
#: Mean grey levels (of 255) the overlay may differ from the export over the caption's pixels.
MAX_TEXT_ERROR = 12
TEXT_DIFF = 60


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _frame_png(video: Path, frame: int, out: Path) -> Path:
    subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-y", "-i", str(video), "-vf", f"select=eq(n\\,{frame}),format=rgb24",
         "-frames:v", "1", str(out)],
        check=True,
    )
    return out


def _composite(frame: Path, still: Path, out: Path) -> Path:
    subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-y", "-i", str(frame), "-i", str(still), "-filter_complex",
         "[0][1]overlay=format=auto,format=rgb24", "-frames:v", "1", str(out)],
        check=True,
    )
    return out


def _band_ssim(a: Path, b: Path, band: tuple[int, int, int, int]) -> float:
    left, top, right, bottom = band
    crop = f"crop={right - left}:{bottom - top}:{left}:{top}"
    run = subprocess.run(
        [harness._tool("ffmpeg"), "-hide_banner", "-i", str(a), "-i", str(b), "-filter_complex",
         f"[0]{crop}[x];[1]{crop}[y];[x][y]ssim", "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(re.findall(r"All:([0-9.]+)", run.stderr)[-1])


def _gray(image: Path, band: tuple[int, int, int, int]) -> bytes:
    left, top, right, bottom = band
    return subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(image), "-vf",
         f"crop={right - left}:{bottom - top}:{left}:{top},format=gray", "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout


def _text_error(exported: Path, shown: Path, plain: Path, band: tuple[int, int, int, int]) -> float:
    """Mean grey difference from the export over the caption's own pixels (where it changes the frame)."""
    e, s, p = _gray(exported, band), _gray(shown, band), _gray(plain, band)
    text = [i for i in range(len(e)) if abs(e[i] - p[i]) > TEXT_DIFF]
    assert len(text) > 500, "no caption text in the band"
    return sum(abs(e[i] - s[i]) for i in text) / len(text)


def _band_masks(video: Path, band: tuple[int, int, int, int]) -> list[bytes]:
    left, top, right, bottom = band
    size = ((right - left) // 4, (bottom - top) // 4)
    # Blue: white text is bright there and the highlighted (yellow) word dark, so a word state
    # changes the mask as a new chunk does.
    chain = (
        f"crop={right - left}:{bottom - top}:{left}:{top},scale={size[0]}:{size[1]}:flags=area,"
        "format=gbrp,extractplanes=b"
    )
    raw = subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(video), "-vf", chain, "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    step = size[0] * size[1]
    return [raw[index * step : (index + 1) * step] for index in range(len(raw) // step)]


#: The uncaptioned export per canvas, shared by the four looks' cases.
_PLAIN: dict[tuple[int, int], Path] = {}


@pytest.fixture(scope="module")
def plain_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("plain")


@pytest.mark.parametrize("style", ["s7-neutral", "s7-box", "s7-karaoke", "s7-minimal"])
@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1080, 1080), (1920, 1080)])
def test_caption_overlay_parity(media, tmp_path: Path, plain_dir: Path, width: int, height: int, style: str) -> None:
    source = media("talking-head-01")
    disk = os.statvfs(tmp_path)
    assert disk.f_bavail * disk.f_frsize > 15 * 2**30, "under 15 GB free; not rendering"
    stored = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    transcript = {
        "media": "cam",
        "fps": stored["fps"],
        "words": [{key: word[key] for key in ("text", "startFrame", "endFrame")} for word in stored["words"]],
    }
    ranges = keep_ranges(SOURCE_FRAMES // 4, SEGMENTS, TOTAL)
    edit = make_edit(source=source, ranges=ranges, fps=RATE, duration_frames=SOURCE_FRAMES, width=width, height=height)
    edit["tracks"].append(
        {"kind": "caption", "id": "C1", "style": style, "items": track_items(export.plan_segments(edit, width, height), transcript)}
    )

    stills = captions._render({"edit": edit, "cacheDir": str(tmp_path / "stills")}, JobContext.detached())
    assert stills["folder"] == captions.look_key(width, height, style)
    still_dir = tmp_path / "stills" / stills["folder"]
    chunks = stills["chunks"]
    assert len(chunks) >= 6
    if style == "s7-karaoke":
        # One still per word being said: more stills than the other looks' chunks.
        assert len(chunks) > len(captions_ass.cues(captions.chunks_of(edit), captions_ass.DEFAULT_STYLE))
    videos = {"captioned": tmp_path / "captioned.mp4"}
    export._render(
        {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(videos["captioned"]), "captions": True},
        JobContext.detached(),
    )
    if (width, height) not in _PLAIN:
        _PLAIN[(width, height)] = plain_dir / f"plain-{width}x{height}.mp4"
        export._render(
            {"edit": edit, "projectDir": str(tmp_path), "outputPath": str(_PLAIN[(width, height)]), "captions": False},
            JobContext.detached(),
        )
    videos["plain"] = _PLAIN[(width, height)]

    safe = captions_ass.layout_for(width, height, captions_ass.load_style(style)).safe
    band = (safe[0], safe[1] + (safe[3] - safe[1]) * 2 // 3, safe[2], safe[3])
    scores, bare, errors = [], [], []
    for index, chunk in enumerate(chunks):
        middle = (chunk["start"] + chunk["end"]) // 2
        exported = _frame_png(videos["captioned"], middle, tmp_path / f"e{index}.png")
        plain = _frame_png(videos["plain"], middle, tmp_path / f"p{index}.png")
        shown = _composite(plain, still_dir / chunk["png"], tmp_path / f"o{index}.png")
        scores.append(_band_ssim(exported, shown, band))
        bare.append(_band_ssim(exported, plain, band))
        errors.append(_text_error(exported, shown, plain, band))
    print(
        f"caption-overlay-parity {width}x{height} {style}: {len(chunks)} stills, band SSIM min {min(scores):.4f}"
        f" (without the overlay: max {max(bare):.4f}); text pixels mean error max {max(errors):.1f}/255"
    )
    assert min(scores) >= MIN_SSIM, scores
    # The band does tell captions apart: the frame without its still scores clearly lower.
    assert max(bare) < min(scores), bare
    assert max(errors) <= MAX_TEXT_ERROR, errors

    # The export shows each chunk from its start to its end (±1): when the overlay switches.
    masks = [
        frozenset(i for i, (a, b) in enumerate(zip(x, y)) if abs(a - b) > TEXT_DIFF)
        for x, y in zip(_band_masks(videos["captioned"], safe), _band_masks(videos["plain"], safe))
    ]
    for chunk in chunks:
        for edge in (chunk["start"], chunk["end"]):
            if 0 < edge < TOTAL:
                window = range(max(1, edge - 1), min(TOTAL, edge + 2))
                assert any(masks[frame] != masks[frame - 1] for frame in window), (chunk, edge)
    videos["captioned"].unlink()
