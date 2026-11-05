# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Helpers for the engine's golden media tests (S7V-031).

Every helper shells out to the developer's FFmpeg (``ffmpeg``/``ffprobe`` on PATH, or
``S7VIDEO_FFMPEG``/``S7VIDEO_FFPROBE``). That FFmpeg is a dev tool and is never shipped.

Units: frame numbers are integers at the clip's or project's frame rate; a cut range is half-open,
``(in_frame, out_frame)`` keeps ``in_frame`` up to but not including ``out_frame``.

API (other cards code against these names):

- ``media_dir()``, ``load_manifest()``, ``clip_entry(id)``, ``cached_clip(id)``: the fetched-clip cache.
- ``synth(spec)``: a deterministic synthetic clip from ``fixtures/media/synth.ts``.
- ``probe_summary(path)``: codecs, size, rate, exact frame count, colour tags, stream starts.
- ``ssim(reference, candidate)``: per-frame SSIM (``.min``, ``.mean``); frame counts must match.
- ``phash(path, frame)`` and ``phash_distance(a, b)``: 64-bit DCT perceptual hash of one frame.
- ``loudness(path)``: EBU R128 integrated LUFS, loudness range and true peak (FFmpeg ``ebur128``).
- ``cut_list_diff(expected, actual)``: ``None`` when equal, else the first differing output frame.
- ``word_timing_diff(expected, actual, fps, actual_unit=...)``: start/end errors against hand-marked
  words; only ``pause``/``gap`` starts are scored by default.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Iterable, Literal, Sequence

REPO_ROOT = Path(__file__).resolve().parents[4]
MANIFEST = REPO_ROOT / "fixtures" / "media" / "manifest.json"
SYNTH_SCRIPT = REPO_ROOT / "fixtures" / "media" / "synth.ts"
FETCH_HINT = "run pnpm media:fetch"


class HarnessError(RuntimeError):
    """An FFmpeg call or a fixture lookup failed."""


# --- Tools and cache -------------------------------------------------------------------------


def _tool(name: str) -> str:
    override = os.environ.get(f"S7VIDEO_{name.upper()}")
    found = override or shutil.which(name)
    if not found:
        raise HarnessError(f"{name} not found on PATH (set S7VIDEO_{name.upper()} to its path)")
    return found


def _run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(list(args), capture_output=True, text=True, check=False)
    if result.returncode != 0:
        tail = "\n".join(result.stderr.strip().splitlines()[-8:])
        raise HarnessError(f"{Path(args[0]).name} exited {result.returncode}: {tail}")
    return result


def media_dir() -> Path:
    """The test-media cache: ``$S7VIDEO_TEST_MEDIA_DIR`` or ``~/Library/Caches/s7video-test-media``."""
    override = os.environ.get("S7VIDEO_TEST_MEDIA_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Caches" / "s7video-test-media"


def load_manifest(path: Path = MANIFEST) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def clip_entry(clip_id: str, manifest: dict | None = None) -> dict:
    for clip in (manifest or load_manifest())["clips"]:
        if clip["id"] == clip_id:
            return clip
    raise HarnessError(f"no clip {clip_id!r} in {MANIFEST.relative_to(REPO_ROOT)}")


def cached_clip(clip_id: str, *, verify_sha256: bool = False) -> Path | None:
    """The cached file for ``clip_id``, or ``None`` when it is missing or the wrong size.

    ``pnpm media:fetch`` already verifies sha256 on download; pass ``verify_sha256`` to re-hash.
    """
    clip = clip_entry(clip_id)
    path = media_dir() / clip["file"]
    if not path.is_file() or path.stat().st_size != clip["size"]:
        return None
    if verify_sha256:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        if digest.hexdigest() != clip["sha256"]:
            return None
    return path


def synth(spec: dict) -> Path:
    """Generate (or reuse) a synthetic clip; ``spec`` is a ``SynthSpec`` from fixtures/media/synth.ts."""
    node = shutil.which("node")
    if not node:
        raise HarnessError("node not found on PATH; synth clips come from fixtures/media/synth.ts")
    out = _run([node, str(SYNTH_SCRIPT), "--spec", json.dumps(spec)]).stdout.strip().splitlines()
    return Path(out[-1])


# --- Probe -------------------------------------------------------------------------------------


def _seconds(value: str | None) -> float | None:
    """ffprobe seconds (``"1.5"``) or a Matroska ``DURATION`` tag (``"00:02:20.001"``), to the ms."""
    if value in (None, "N/A"):
        return None
    total = 0.0
    for part in str(value).split(":"):
        total = total * 60 + float(part)
    return round(total, 3)


def probe_summary(path: Path | str) -> dict:
    """What a golden compares exactly: container, codecs, size, rate, frame count, colour tags,
    and each stream's start (and the audio duration) for A/V sync checks.

    ``video_frames`` counts the video packets (exact, no decode); ``duration_frames`` is the same
    figure, named for the testing.md tolerance table.
    """
    data = json.loads(
        _run(
            [
                _tool("ffprobe"),
                "-v",
                "error",
                "-count_packets",
                "-show_entries",
                "format=format_name:stream=index,codec_type,codec_name,profile,width,height,"
                "pix_fmt,r_frame_rate,avg_frame_rate,nb_read_packets,sample_rate,channels,"
                "color_range,color_space,color_transfer,color_primaries,start_time,duration"
                ":stream_tags=DURATION",
                "-of",
                "json",
                str(path),
            ]
        ).stdout
    )
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    summary: dict = {"format": data.get("format", {}).get("format_name")}
    if video:
        frames = int(video.get("nb_read_packets", 0))
        summary.update(
            video_codec=video.get("codec_name"),
            width=video.get("width"),
            height=video.get("height"),
            pix_fmt=video.get("pix_fmt"),
            fps=video.get("r_frame_rate"),
            video_frames=frames,
            duration_frames=frames,
            color_range=video.get("color_range"),
            color_space=video.get("color_space"),
            color_transfer=video.get("color_transfer"),
            color_primaries=video.get("color_primaries"),
            video_start_s=_seconds(video.get("start_time")),
        )
    if audio:
        summary.update(
            audio_codec=audio.get("codec_name"),
            audio_rate=int(audio["sample_rate"]) if audio.get("sample_rate") else None,
            audio_channels=audio.get("channels"),
            audio_start_s=_seconds(audio.get("start_time")),
            audio_duration_s=_seconds(audio.get("duration") or audio.get("tags", {}).get("DURATION")),
        )
    return summary


# --- Picture -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class SsimResult:
    """SSIM ("All") per frame pair; testing.md's ≥ 0.98 applies to every sampled frame (``min``)."""

    per_frame: tuple[float, ...]

    @property
    def mean(self) -> float:
        return sum(self.per_frame) / len(self.per_frame)

    @property
    def min(self) -> float:
        return min(self.per_frame)

    @property
    def worst_frame(self) -> int:
        return self.per_frame.index(self.min)


def ssim(reference: Path | str, candidate: Path | str) -> SsimResult:
    """Per-frame SSIM of two clips of the same size and frame count (FFmpeg ``ssim``).

    Raises ``HarnessError`` when the frame counts differ: FFmpeg's framesync would otherwise
    repeat the last frame of the shorter clip and hide a truncated render.
    """
    ref_frames = probe_summary(reference).get("video_frames")
    cand_frames = probe_summary(candidate).get("video_frames")
    if ref_frames != cand_frames:
        raise HarnessError(
            f"frame counts differ: reference {ref_frames}, candidate {cand_frames}"
        )
    with tempfile.TemporaryDirectory(prefix="s7v-ssim-") as tmp:
        stats = Path(tmp) / "ssim.log"
        _run(
            [
                _tool("ffmpeg"),
                "-hide_banner",
                "-nostats",
                "-i",
                str(candidate),
                "-i",
                str(reference),
                "-lavfi",
                f"[0:v][1:v]ssim=stats_file={_filter_path(stats)}",
                "-f",
                "null",
                "-",
            ]
        )
        values = [
            1.0 if m.group(1) == "inf" else float(m.group(1))
            for m in re.finditer(r"All:([0-9.]+|inf)", stats.read_text(encoding="utf-8"))
        ]
    if len(values) != ref_frames:
        raise HarnessError(f"ffmpeg ssim scored {len(values)} frames, expected {ref_frames}")
    return SsimResult(tuple(values))


def _filter_path(path: Path) -> str:
    """Escape a path for use as a filter option value."""
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _frame_gray(path: Path | str, frame: int, size: int) -> list[list[float]]:
    raw = subprocess.run(
        [
            _tool("ffmpeg"),
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"select=eq(n\\,{frame}),scale={size}:{size}:flags=area,format=gray",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-",
        ],
        capture_output=True,
        check=False,
    )
    if raw.returncode != 0 or len(raw.stdout) != size * size:
        raise HarnessError(f"could not read frame {frame} of {path}")
    data = raw.stdout
    return [[float(data[y * size + x]) for x in range(size)] for y in range(size)]


def _dct_1d(values: Sequence[float]) -> list[float]:
    n = len(values)
    return [
        sum(v * math.cos(math.pi * (i + 0.5) * k / n) for i, v in enumerate(values))
        for k in range(n)
    ]


def phash(path: Path | str, frame: int = 0) -> int:
    """64-bit perceptual hash of video frame ``frame``: 32x32 grey, DCT, 8x8 low band vs median."""
    pixels = _frame_gray(path, frame, 32)
    rows = [_dct_1d(row) for row in pixels]
    cols = [_dct_1d([rows[y][x] for y in range(32)]) for x in range(8)]
    low = [cols[x][y] for y in range(8) for x in range(8)]
    median = sorted(low[1:])[len(low[1:]) // 2]  # skip the DC term, as pHash does
    bits = 0
    for value in low:
        bits = (bits << 1) | (1 if value > median else 0)
    return bits


def phash_distance(a: int, b: int) -> int:
    """Hamming distance between two ``phash`` values (testing.md allows ≤ 6)."""
    return bin(a ^ b).count("1")


# --- Loudness ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Loudness:
    integrated_lufs: float
    loudness_range_lu: float
    true_peak_dbtp: float


def loudness(path: Path | str) -> Loudness:
    """EBU R128 / BS.1770-4 integrated loudness and true peak of the first audio stream."""
    result = _run(
        [
            _tool("ffmpeg"),
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
        ]
    )
    summary = result.stderr[result.stderr.rfind("Summary:") :]

    def grab(label: str) -> float:
        match = re.search(rf"{label}:\s+(-?[0-9.]+|-inf)", summary)
        if not match:
            raise HarnessError(f"ebur128 summary has no {label}")
        return float(match.group(1))

    return Loudness(grab("I"), grab("LRA"), grab("Peak"))


# --- Cut lists ---------------------------------------------------------------------------------


CutRange = tuple[int, int]


@dataclass(frozen=True)
class CutDiff:
    """Where two cut lists first disagree, in output (timeline) frames."""

    output_frame: int
    expected_source_frame: int | None
    actual_source_frame: int | None

    def __str__(self) -> str:
        def show(frame: int | None) -> str:
            return "nothing (list ended)" if frame is None else f"source frame {frame}"

        return (
            f"cut lists differ at output frame {self.output_frame}: expected "
            f"{show(self.expected_source_frame)}, got {show(self.actual_source_frame)}"
        )


def _expand(ranges: Iterable[CutRange]) -> Iterable[int]:
    for start, end in ranges:
        if end < start:
            raise ValueError(f"cut range ({start}, {end}) ends before it starts")
        yield from range(start, end)


def cut_list_diff(expected: Iterable[CutRange], actual: Iterable[CutRange]) -> CutDiff | None:
    """Compare two keep-range lists frame by frame; ``None`` when every output frame matches.

    Each list is played in order: output frame ``n`` shows the ``n``-th source frame the ranges
    keep. Splitting a range in two without moving a frame is not a difference.
    """
    exp = list(_expand(expected))
    act = list(_expand(actual))
    for index in range(max(len(exp), len(act))):
        e = exp[index] if index < len(exp) else None
        a = act[index] if index < len(act) else None
        if e != a:
            return CutDiff(index, e, a)
    return None


# --- Word timings ------------------------------------------------------------------------------

# Hand-marked edges trusted for scoring: bordering a pause or a quiet gap. ``dip`` edges were found
# near an aligner's boundary, so they are reported but not scored by default.
SCORED_EDGES = ("pause", "gap")


def _norm(text: str) -> str:
    return re.sub(r"[^\w']", "", text.lower().replace("\u2019", "'"))


@dataclass
class WordTimingReport:
    """Start and end errors (actual − expected) for each expected word that was matched.

    Only ``scored`` words (start edge in ``score_edges``) count towards the mean and the share.
    """

    fps: Fraction
    matched: list[dict] = field(default_factory=list)
    missing: list[dict] = field(default_factory=list)

    @property
    def scored(self) -> list[dict]:
        return [m for m in self.matched if m["scored"]]

    @property
    def start_errors_ms(self) -> list[float]:
        return [m["start_error_ms"] for m in self.scored]

    @property
    def mean_abs_start_error_ms(self) -> float:
        errors = self.start_errors_ms
        return sum(abs(e) for e in errors) / len(errors) if errors else math.inf

    @property
    def within_one_frame(self) -> float:
        """Share of scored words whose start is within one frame of the hand mark."""
        if not self.scored:
            return 0.0
        return sum(1 for m in self.scored if abs(m["start_error_frames"]) <= 1) / len(self.scored)

    def passes(self, *, mean_ms: float = 50.0, share_within_frame: float = 0.9) -> bool:
        """PRD-002 targets: mean start error < 50 ms and 90% of starts within one frame."""
        return (
            not self.missing
            and self.mean_abs_start_error_ms < mean_ms
            and self.within_one_frame >= share_within_frame
        )

    def summary(self) -> str:
        return (
            f"{len(self.scored)} scored of {len(self.matched)} matched, {len(self.missing)} "
            f"missing; mean |start error| {self.mean_abs_start_error_ms:.1f} ms; "
            f"{self.within_one_frame:.0%} within one frame"
        )


def _expected_seconds(word: dict, edge: str, rate: Fraction) -> float:
    exact = word.get(f"{edge}Seconds")
    return float(exact) if exact is not None else float(Fraction(word[edge]) / rate)


def _actual_seconds(word: dict, edge: str, unit: str, rate: Fraction) -> float:
    if f"{edge}Seconds" in word:
        return float(word[f"{edge}Seconds"])
    value = word[edge]
    return float(Fraction(value) / rate) if unit == "frames" else float(value)


def word_timing_diff(
    expected: Sequence[dict],
    actual: Sequence[dict],
    fps: Fraction | str,
    *,
    actual_unit: Literal["seconds", "frames"],
    score_edges: Iterable[str] | None = SCORED_EDGES,
    search_window_s: float = 0.5,
) -> WordTimingReport:
    """Match hand-marked words to transcript words and measure timing errors.

    ``expected`` is the words.json shape: ``text``, integer ``start``/``end`` frames, and
    ``startSeconds``/``endSeconds`` (used when present, so frame rounding adds no error) plus
    ``startEdge``. ``actual`` items have ``text`` (or ``w``) and ``start``/``end`` in
    ``actual_unit``; ``startSeconds``/``endSeconds`` in an item always win. A word matches the same
    normalised text whose start is closest within ``search_window_s``. Words whose ``startEdge``
    is not in ``score_edges`` are reported but not scored (``None`` scores every word).
    """
    rate = Fraction(fps) if not isinstance(fps, Fraction) else fps
    edges = None if score_edges is None else set(score_edges)
    report = WordTimingReport(rate)
    candidates = [
        {
            "text": _norm(str(a.get("text", a.get("w", "")))),
            "start": _actual_seconds(a, "start", actual_unit, rate),
            "end": _actual_seconds(a, "end", actual_unit, rate),
        }
        for a in actual
    ]
    used: set[int] = set()
    for word in expected:
        start_s = _expected_seconds(word, "start", rate)
        end_s = _expected_seconds(word, "end", rate)
        text = _norm(word["text"])
        best: tuple[float, int] | None = None
        for index, cand in enumerate(candidates):
            if index in used or cand["text"] != text:
                continue
            distance = abs(cand["start"] - start_s)
            if distance <= search_window_s and (best is None or distance < best[0]):
                best = (distance, index)
        if best is None:
            report.missing.append(word)
            continue
        used.add(best[1])
        cand = candidates[best[1]]
        report.matched.append(
            {
                "text": word["text"],
                "scored": edges is None or word.get("startEdge", "pause") in edges,
                "start_error_ms": (cand["start"] - start_s) * 1000,
                "end_error_ms": (cand["end"] - end_s) * 1000,
                "start_error_frames": round(cand["start"] * rate) - word["start"],
                "end_error_frames": round(cand["end"] * rate) - word["end"],
            }
        )
    return report
