# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``ffmpeg-captions-9x16``: the bundled LGPL FFmpeg helper burns in captions (S7V-016).

A 10 s 1080×1920 ``testsrc2`` pattern at 30 fps with a 440 Hz tone gets an ASS file of our own
(English in the bundled Inter Bold, plus a Japanese line Inter has no glyphs for) burned in the way
the engine does it (``subtitles=…:fontsdir=fonts`` over ``captions_ass.link_fonts``), encoded with
``h264_videotoolbox`` and AAC. It is checked on:

- **the helper**: the FFmpeg under test is LGPL (no ``--enable-gpl``/``nonfree``/``version3``);
- **pictures**: SSIM ≥ 0.97 at 1, 5 and 9 s against the same frames made losslessly, and pHash ≤ 6
  against the reference;
- **captions**: both caption bands differ from the uncaptioned pattern, the rest of the frame
  does not;
- **fonts** (Check 1): libass takes Latin text from the bundled Inter Bold and finds a macOS system
  font for the Japanese glyphs through CoreText, with no fontconfig and no missing-glyph fallback;
- **format and length**: H.264 High, 300 frames (±1), AAC 48 kHz stereo;
- **loudness**: within 0.5 LU of the reference.

It runs against the helper ``packages/engine/ffmpeg/build.sh`` built (or ``S7VIDEO_FFMPEG``), and
skips when none is built. The reference holds data only; a legitimate change is recorded with
``S7VIDEO_GOLDEN_UPDATE=1`` and explained in the PR.
Run with ``pnpm test:golden -- ffmpeg-captions-9x16``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

import harness
from s7engine import captions_ass

REFERENCE = Path(__file__).parent / "references" / "ffmpeg-captions-9x16.json"
BUILD_SCRIPT = harness.REPO_ROOT / "packages" / "engine" / "ffmpeg" / "build.sh"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
WIDTH, HEIGHT, FPS, SECONDS = 1080, 1920, 30, 10
SAMPLES = (30, 150, 270)  # 1, 5 and 9 s
SSIM_MIN = 0.97
PHASH_MAX = 6
LUFS_TOLERANCE = 0.5
THUMB = (108, 192)
# Rows of the 108×192 thumbnail: the Japanese line (top, MarginV 300), the English line (bottom,
# MarginV 300) and a band between them that no caption touches.
JP_ROWS, EN_ROWS, CLEAR_ROWS = slice(28, 44), slice(148, 164), slice(70, 120)
PATTERN = f"testsrc2=size={WIDTH}x{HEIGHT}:rate={FPS}:duration={SECONDS},format=yuv420p"
TONE = f"sine=frequency=440:sample_rate=48000:duration={SECONDS}"
JAPANESE = "こんにちは、字幕テスト"

CAPTIONS = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,96,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,300,1
Style: JP,Inter,90,&H0000E5FF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,8,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:03.50,Default,,0,0,0,,LGPL helper test
Dialogue: 0,0:00:03.50,0:00:07.00,Default,,0,0,0,,{{\\c&H0080FF&}}libass{{\\c&HFFFFFF&}} + VideoToolbox
Dialogue: 0,0:00:07.00,0:00:10.00,Default,,0,0,0,,captions burn in
Dialogue: 0,0:00:00.00,0:00:10.00,JP,,0,0,0,,{JAPANESE}
"""


def _helper_tools() -> tuple[str, str]:
    """The helper's ffmpeg and ffprobe: ``S7VIDEO_FFMPEG``, else the one ``build.sh`` built."""
    if os.environ.get("S7VIDEO_FFMPEG"):
        return harness._tool("ffmpeg"), harness._tool("ffprobe")
    helper = subprocess.run(
        ["bash", str(BUILD_SCRIPT), "--print-dir"], check=True, capture_output=True, text=True
    ).stdout.strip()
    ffmpeg = Path(helper) / "bin" / "ffmpeg"
    if not ffmpeg.is_file():
        pytest.skip(f"no FFmpeg helper built at {helper}: run {BUILD_SCRIPT}")
    return str(ffmpeg), str(ffmpeg.with_name("ffprobe"))


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    ffmpeg, ffprobe = _helper_tools()
    # harness.probe_summary, ssim, phash and loudness read these.
    monkeypatch.setenv("S7VIDEO_FFMPEG", ffmpeg)
    monkeypatch.setenv("S7VIDEO_FFPROBE", ffprobe)
    return ffmpeg, ffprobe


def _ffmpeg(ffmpeg: str, args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", *args], cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise harness.HarnessError(f"ffmpeg failed: {result.stderr[-2000:]}")
    return result


def _gray(ffmpeg: str, args: list[str], cwd: Path) -> np.ndarray:
    """The sampled frames as 108×192 grey, from inputs ``args`` whose first video is ``[0:v]``."""
    select = "+".join(f"eq(n\\,{frame})" for frame in SAMPLES)
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", *args, "-vf", f"select={select},scale={THUMB[0]}:{THUMB[1]}:flags=area,format=gray",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        cwd=cwd, check=True, capture_output=True,
    ).stdout
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, THUMB[1], THUMB[0]).astype(np.float64)
    assert len(frames) == len(SAMPLES), f"read {len(frames)} sampled frames"
    return frames


def _sampled_ssim(ffmpeg: str, render: Path, work: Path) -> list[float]:
    """SSIM of the encoded frames at SAMPLES against the same graph's frames before encoding."""
    select = "+".join(f"eq(n\\,{frame})" for frame in SAMPLES)
    stats = work / "ssim.log"
    graph = (
        f"[0:v]select={select},settb=1/{FPS},setpts=N[enc];"
        f"{PATTERN},subtitles=filename=captions.ass:fontsdir=fonts,select={select},settb=1/{FPS},setpts=N[ref];"
        f"[enc][ref]ssim=stats_file={stats.name}"
    )
    _ffmpeg(ffmpeg, ["-i", str(render), "-filter_complex", graph, "-f", "null", "-"], work)
    return [float(match) for match in re.findall(r"All:([0-9.]+)", stats.read_text(encoding="utf-8"))]


def _font_log(ffmpeg: str, work: Path) -> str:
    """libass's font choices (FFmpeg forwards them at info level) for one frame with both lines."""
    result = _ffmpeg(
        ffmpeg,
        ["-v", "info", "-f", "lavfi", "-i", PATTERN, "-vf", "subtitles=filename=captions.ass:fontsdir=fonts",
         "-ss", "5", "-frames:v", "1", "-f", "null", "-"],
        work,
    )
    return result.stderr


def test_ffmpeg_captions_9x16(tools: tuple[str, str], tmp_path: Path) -> None:
    ffmpeg, _ = tools
    buildconf = _ffmpeg(ffmpeg, ["-buildconf"], tmp_path).stdout
    for flag in ("--enable-gpl", "--enable-nonfree", "--enable-version3"):
        assert flag not in buildconf.split(), f"{ffmpeg} is not the LGPL helper: it has {flag}"

    (tmp_path / "captions.ass").write_text(CAPTIONS, encoding="utf-8")
    captions_ass.link_fonts(tmp_path / "fonts")
    render = tmp_path / "captions-9x16.mp4"
    started = time.monotonic()
    _ffmpeg(
        ffmpeg,
        ["-y", "-f", "lavfi", "-i", PATTERN, "-f", "lavfi", "-i", TONE,
         "-vf", "subtitles=filename=captions.ass:fontsdir=fonts",
         "-c:v", "h264_videotoolbox", "-b:v", "6M", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", "-shortest", str(render)],
        tmp_path,
    )
    elapsed = time.monotonic() - started
    print(f"ffmpeg-captions-9x16: {SECONDS} s rendered in {elapsed:.1f} s ({SECONDS / elapsed:.1f}x realtime)")

    summary = harness.probe_summary(render)
    assert summary["video_codec"] == "h264" and summary["width"] == WIDTH and summary["height"] == HEIGHT
    assert summary["fps"] == f"{FPS}/1"
    assert abs(summary["video_frames"] - FPS * SECONDS) <= 1, summary
    assert summary["audio_codec"] == "aac" and summary["audio_rate"] == 48000 and summary["audio_channels"] == 2

    scores = _sampled_ssim(ffmpeg, render, tmp_path)
    assert len(scores) == len(SAMPLES) and min(scores) >= SSIM_MIN, scores
    print(f"ffmpeg-captions-9x16: SSIM at 1/5/9 s {scores}")

    captioned = _gray(ffmpeg, ["-i", str(render)], tmp_path)
    plain = _gray(ffmpeg, ["-f", "lavfi", "-i", PATTERN], tmp_path)
    difference = np.abs(captioned - plain)
    clear = float(difference[:, CLEAR_ROWS, :].mean())
    for name, rows in (("Japanese", JP_ROWS), ("English", EN_ROWS)):
        band = difference[:, rows, :].mean(axis=(1, 2))
        assert float(band.min()) > max(3.0, 4 * clear), f"{name} captions missing: {band.tolist()}, rest {clear:.2f}"

    fonts = _font_log(ffmpeg, tmp_path)
    assert "fontconfig" not in fonts.lower(), "libass used fontconfig"
    # "fontselect: (Inter, 700, 0) -> <file or memory font>, <index>, <PostScript name>"; a font from
    # fontsdir is loaded into memory, so it has no path.
    picks = re.findall(r"fontselect: \(([^,]+), \d+, \d+\) -> (.+?), -?\d+, (\S+)", fonts)
    assert ("Inter", "Inter-Bold", "Inter-Bold") in picks, f"Latin text did not use the bundled Inter Bold: {fonts}"
    assert "Failed to find any fallback" not in fonts, "Japanese glyphs fell back to missing-glyph boxes"
    fallbacks = sorted({(source, name) for _, source, name in picks if name != "Inter-Bold"})
    assert fallbacks, f"no system font was found for {JAPANESE}: {fonts}"
    # Only macOS's own fonts, which every Mac has: nothing the user must install.
    assert all(source.startswith("/System/Library/Fonts/") for source, _ in fallbacks), fallbacks

    level = harness.loudness(render)
    hashes = {str(frame): harness.phash(render, frame) for frame in SAMPLES}
    record = {
        "summary": {key: summary[key] for key in ("video_codec", "width", "height", "fps", "video_frames", "audio_codec", "audio_rate", "audio_channels", "color_range")},
        "integrated_lufs": round(level.integrated_lufs, 2),
        "phash": {frame: f"{value:016x}" for frame, value in hashes.items()},
        "latin_font": "Inter-Bold",
        "japanese_fallback": [name for _, name in fallbacks],
    }
    if UPDATE or not REFERENCE.exists():
        REFERENCE.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        if not UPDATE:
            pytest.fail(f"wrote a new reference {REFERENCE.name}; check it and commit it")
        return
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    assert record["summary"] == reference["summary"]
    assert abs(record["integrated_lufs"] - reference["integrated_lufs"]) <= LUFS_TOLERANCE
    for frame, value in reference["phash"].items():
        distance = harness.phash_distance(hashes[frame], int(value, 16))
        assert distance <= PHASH_MAX, f"frame {frame}: pHash distance {distance}"
