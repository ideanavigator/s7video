# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``import-probe-proxy``: what import measures and the preview proxy it makes (S7V-025).

For a synthetic 4K clip with a 10 s GOP (the case spike A2 says needs a proxy) and the real
``talking-head-01`` (AV1 in WebM, 23.976 fps):

- ``media.keyframes`` reports the longest keyframe gap; the 4K clip is over the 2 s threshold and
  the talking head is compared with its reference.
- ``media.proxy`` keeps every source timestamp: the proxy's video packet PTS list equals the
  original's exactly, so its frame count and time base match too. Colour tags are equal.
- Proxy frame N matches original frame N scaled to the proxy's size: SSIM ≥ 0.98, pHash ≤ 6.
  On the testsrc2 clip a neighbouring frame scores well below that, so an off-by-one fails.
- The original's bytes and mtime are unchanged.

References are data (JSON). Record a legitimate change with ``S7VIDEO_GOLDEN_UPDATE=1``.
Run with ``pnpm test:golden -- import-probe-proxy``.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

import harness
from s7engine.jobs import JobContext
from s7engine.methods import probe as probe_method
from s7engine.methods import proxy as proxy_method

REFERENCE = Path(__file__).parent / "references" / "import-probe-proxy.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
SSIM_MIN = 0.98
PHASH_MAX = 6
LONG_GOP_SECONDS = 2

SYNTH_4K_LONG_GOP = {
    "name": "import-proxy-4k-gop10",
    "fps": "30/1",
    "width": 3840,
    "height": 2160,
    "gop": 300,
    "audio": [{"seconds": 6, "toneHz": 440}],
}
# Frames past the first keyframe, so the proxy's frame has to be the same one, not just close.
CASES = {"synth-4k-gop10": 95, "talking-head-01": 1200}


@pytest.fixture(autouse=True)
def engine_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("S7_FFMPEG", harness._tool("ffmpeg"))
    monkeypatch.setenv("S7_FFPROBE", harness._tool("ffprobe"))


def _video_pts(path: Path) -> list[int]:
    out = subprocess.run(
        [harness._tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts", "-of", "csv=p=0", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return sorted(int(line) for line in out.split() if line.strip())


def _frame_png(clip: Path, frame: int, out: Path, size: tuple[int, int] | None = None) -> Path:
    """Frame ``frame`` decoded from the start, optionally scaled: no seek is involved.

    A scaled frame goes through 4:2:0 at the target size, as every 1080p proxy does, so SSIM
    measures the proxy's encoding loss rather than the chroma it cannot have.
    """
    filters = f"select=eq(n\\,{frame})" + (
        f",scale={size[0]}:{size[1]},format=yuv420p" if size else ""
    )
    subprocess.run(
        [harness._tool("ffmpeg"), "-v", "error", "-i", str(clip), "-vf", filters, "-frames:v", "1", "-y", str(out)],
        check=True,
    )
    return out


def _file_state(path: Path) -> tuple[str, int]:
    return hashlib.sha256(path.read_bytes()).hexdigest(), os.stat(path).st_mtime_ns


def _check(case: str, clip: Path, tmp_path: Path) -> None:
    reference = json.loads(REFERENCE.read_text(encoding="utf-8")) if REFERENCE.exists() else {}
    before = _file_state(clip)
    job = JobContext.detached()
    video = probe_method.METHOD.handler({"path": str(clip)}, job)["video"]
    keyframes = proxy_method.KEYFRAMES.handler({"path": str(clip)}, job)
    gap_ms = keyframes["maxGapTicks"] * 1000 * keyframes["timeBase"]["num"] // keyframes["timeBase"]["den"]

    output = tmp_path / "proxies" / f"{case}.mp4"
    proxy_method.PROXY.handler(
        {
            "jobId": f"golden-{case}",
            "path": str(clip),
            "outputPath": str(output),
            "rate": video["frameRate"],
            "timeBase": video["timeBase"],
            "durationFrames": video["durationFrames"],
            "color": {key: value for key, value in video["color"].items() if value is not None},
        },
        job,
    )
    assert _video_pts(output) == _video_pts(clip), f"{case}: proxy timestamps differ"
    source, proxy = harness.probe_summary(clip), harness.probe_summary(output)
    assert proxy["video_frames"] == source["video_frames"]
    assert proxy["fps"] == source["fps"]
    for tag in ("range", "space", "transfer", "primaries"):
        if source[f"color_{tag}"] is not None:
            assert proxy[f"color_{tag}"] == source[f"color_{tag}"], f"{case}: colour {tag}"
    assert max(proxy["width"], proxy["height"]) <= 1920

    n = CASES[case]
    size = (proxy["width"], proxy["height"])
    original_png = _frame_png(clip, n, tmp_path / f"original-{n}.png", size)
    proxy_png = _frame_png(output, n, tmp_path / f"proxy-{n}.png")
    score = harness.ssim(original_png, proxy_png)
    proxy_hash = harness.phash(proxy_png)
    assert score.min >= SSIM_MIN, f"{case} frame {n}: SSIM {score.min:.4f} vs the original"
    assert harness.phash_distance(proxy_hash, harness.phash(original_png)) <= PHASH_MAX
    assert _file_state(clip) == before, f"{case}: the original changed"

    record = {
        "frame": n,
        "maxKeyframeGapMs": gap_ms,
        "proxy": {key: proxy[key] for key in ("video_codec", "width", "height", "fps", "video_frames", "pix_fmt")},
        "proxyFramePhash": f"{proxy_hash:016x}",
    }
    if UPDATE:
        reference[case] = record
        REFERENCE.write_text(json.dumps(reference, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return
    expected = reference[case]
    assert record["proxy"] == expected["proxy"]
    assert record["maxKeyframeGapMs"] == expected["maxKeyframeGapMs"]
    distance = harness.phash_distance(proxy_hash, int(expected["proxyFramePhash"], 16))
    assert distance <= PHASH_MAX, f"{case} frame {n}: pHash distance {distance} from the reference"


def test_long_gop_4k_proxy_keeps_every_frame(synth_clip, tmp_path: Path) -> None:
    clip = synth_clip(SYNTH_4K_LONG_GOP)
    keyframes = proxy_method.KEYFRAMES.handler({"path": str(clip)}, JobContext.detached())
    tick: dict[str, Any] = keyframes["timeBase"]
    assert keyframes["maxGapTicks"] * tick["num"] > LONG_GOP_SECONDS * tick["den"]
    _check("synth-4k-gop10", clip, tmp_path)
    # A neighbouring frame is clearly different, so the SSIM check above can see an off-by-one.
    near = harness.ssim(
        _frame_png(clip, CASES["synth-4k-gop10"] + 1, tmp_path / "near.png", (1920, 1080)),
        tmp_path / f"proxy-{CASES['synth-4k-gop10']}.png",
    )
    assert near.min < SSIM_MIN


def test_talking_head_proxy_keeps_every_frame(media, tmp_path: Path) -> None:
    _check("talking-head-01", media("talking-head-01"), tmp_path)
