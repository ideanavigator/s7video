# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.filmstrip`: small frames of a clip as JPEG sprite sheets, one set per zoom level (S7V-035).

One FFmpeg decode feeds every level (`split`): decoding is the whole cost, so one pass for all
levels takes as long as one pass for the coarsest (8.4 s against 8.2 s for 30 minutes of 1080p30
on an M4 Max). Each level keeps the first frame of every `secondsPerTile` stretch, counted from the
video's first frame, and tiles them `columns` x `rows` per sheet. `showinfo` reports the PTS of
every kept frame, and the index stores it as an integer frame at the caller's `rate`, the same
numbering `media.frame` uses, so a tile names the frame it actually shows, on VFR footage too.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import subprocess
from fractions import Fraction
from typing import Any

from .. import timebase
from ..ffmpeg import _tool_env, ffprobe_json, tool_path
from ..jobs import Cancelled, JobContext
from ..rpc import INVALID_PARAMS, MEDIA_ERROR, OUTPUT_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, RATE_SCHEMA, media_file
from .peaks import INDEX_FILE, INDEX_VERSION, publish, staging_dir

DEFAULT_LEVELS = (16, 4, 1)
DEFAULT_TILE_HEIGHT = 90
COLUMNS = 10
ROWS = 10
_SHOWINFO = re.compile(r"\[showinfo@l(\d+) @ [^\]]*\] n:\s*\d+ pts:\s*(-?\d+)")


def level_name(seconds: int) -> str:
    return f"{seconds}s"


def sheet_file(seconds: int, sheet: int) -> str:
    """Sheets count from 1, as FFmpeg's image2 numbering does."""
    return f"{level_name(seconds)}-{sheet}.jpg"


def tile_position(tile: int, columns: int = COLUMNS, rows: int = ROWS) -> tuple[int, int, int]:
    """The sheet (from 1), row and column of the `tile`-th kept frame of a level."""
    per_sheet = columns * rows
    within = tile % per_sheet
    return tile // per_sheet + 1, within // columns, within % columns


def select_expression(seconds: int, start: Fraction) -> str:
    # The first frame at or after each multiple of `seconds` from the video's start.
    origin = timebase.decimal_seconds(start)
    bucket = f"floor((t-{origin})/{seconds})"
    return f"select='isnan(prev_selected_t)+gte({bucket},floor((prev_selected_t-{origin})/{seconds})+1)'"


def filter_graph(levels: list[int], start: Fraction, tile_height: int) -> str:
    # Width follows the display aspect ratio, kept even; square pixels in the sheet.
    scale = f"scale=w='max(2,trunc({tile_height}*dar/2+0.5)*2)':h={tile_height},setsar=1"
    names = [f"[s{seconds}]" for seconds in levels]
    chains = [f"[0:v:0]split={len(levels)}{''.join(names)}" if len(levels) > 1 else f"[0:v:0]null{names[0]}"]
    for seconds, name in zip(levels, names):
        chains.append(
            f"{name}{select_expression(seconds, start)},showinfo@l{seconds},{scale},tile={COLUMNS}x{ROWS}[o{seconds}]"
        )
    return ";".join(chains)


def jpeg_size(path: str) -> tuple[int, int]:
    """Width and height from a JPEG's start-of-frame marker."""
    with open(path, "rb") as handle:
        data = handle.read(1 << 16)
    at = 2
    while at + 9 < len(data):
        if data[at] != 0xFF:
            at += 1
            continue
        marker = data[at + 1]
        length = int.from_bytes(data[at + 2 : at + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            height = int.from_bytes(data[at + 5 : at + 7], "big")
            width = int.from_bytes(data[at + 7 : at + 9], "big")
            return width, height
        at += 2 + length
    raise RpcError(OUTPUT_ERROR, "a filmstrip sheet is unreadable")


def _video_stream(path: str, job: JobContext) -> tuple[Fraction, int, Fraction]:
    info = ffprobe_json(
        [
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=start_pts,time_base:stream_disposition=attached_pic",
            path,
        ],
        job,
    )
    streams = [stream for stream in info.get("streams") or [] if not (stream.get("disposition") or {}).get("attached_pic")]
    if not streams:
        raise RpcError(MEDIA_ERROR, "the file has no video")
    time_base = timebase.parse_rational(streams[0].get("time_base"))
    if time_base is None:
        raise RpcError(MEDIA_ERROR, "the video has no time base")
    try:
        start_pts = int(streams[0].get("start_pts") or 0)
    except (TypeError, ValueError):
        start_pts = 0
    try:
        duration = Fraction((info.get("format") or {}).get("duration") or "0")
    except (TypeError, ValueError):
        duration = Fraction(0)
    return time_base, start_pts, duration


def _run_ffmpeg(
    args: list[str], job: JobContext, total: Fraction, start: Fraction, time_base: Fraction, finest: int
) -> dict[int, list[int]]:
    """Runs the pass and returns the PTS of every kept frame, per level.

    Progress follows the finest level's kept frames: FFmpeg's own `-progress` counts output
    frames, and a sheet is output only every 100 tiles.
    """
    process = subprocess.Popen(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=_tool_env(), text=True
    )
    # Below the app and the engine's quick calls: a long decode must not make the UI stutter.
    with contextlib.suppress(OSError):
        os.setpriority(os.PRIO_PROCESS, process.pid, 10)
    stop = process.kill
    job.on_cancel(stop)
    kept: dict[int, list[int]] = {}
    try:
        assert process.stderr is not None
        for line in process.stderr:
            match = _SHOWINFO.search(line)
            if not match:
                continue
            level, pts = int(match.group(1)), int(match.group(2))
            kept.setdefault(level, []).append(pts)
            if level == finest and total > 0 and not job.cancelled:
                done = pts * time_base - start
                job.progress(min(max(done / total, Fraction(0)), Fraction(99, 100)), "picture strip")
        process.wait()
    except Cancelled:
        process.kill()
        process.wait()
        raise
    finally:
        job.remove_on_cancel(stop)
    job.raise_if_cancelled()
    if process.returncode != 0:
        raise RpcError(MEDIA_ERROR, "the picture strip could not be made")
    return kept


def _filmstrip(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    output_dir = params["outputDir"]
    rate = timebase.from_rational(params["rate"])
    levels = list(params.get("levels") or DEFAULT_LEVELS)
    tile_height = params.get("tileHeight", DEFAULT_TILE_HEIGHT)
    if len(set(levels)) != len(levels):
        raise RpcError(INVALID_PARAMS, "invalid params at levels: must be distinct")
    # Coarsest first, so its sheets are listed and published first.
    levels.sort(reverse=True)
    media_file(path)
    job.progress(0, "picture strip")
    time_base, start_pts, duration = _video_stream(path, job)
    start = start_pts * time_base
    staging = staging_dir(output_dir)
    try:
        args = [
            tool_path("ffmpeg"),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "info",
            "-nostats",
            "-copyts",
            "-i",
            path,
            "-filter_complex",
            filter_graph(levels, start, tile_height),
        ]
        for seconds in levels:
            pattern = os.path.join(staging, f"{level_name(seconds)}-%d.jpg")
            args += ["-map", f"[o{seconds}]", "-fps_mode", "passthrough", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2", pattern]
        kept = _run_ffmpeg(args, job, duration, start, time_base, min(levels))
        entries = []
        names: list[str] = []
        tile_width = 0
        for seconds in levels:
            frames = [timebase.pts_to_frame(pts, time_base, rate, start_pts) for pts in kept.get(seconds, [])]
            sheet_count = -(-len(frames) // (COLUMNS * ROWS))
            sheets = [sheet_file(seconds, sheet) for sheet in range(1, sheet_count + 1)]
            missing = [name for name in sheets if not os.path.isfile(os.path.join(staging, name))]
            if missing or not frames:
                raise RpcError(MEDIA_ERROR, "the picture strip could not be made")
            if tile_width == 0:
                tile_width = jpeg_size(os.path.join(staging, sheets[0]))[0] // COLUMNS
            names += sheets
            entries.append(
                {
                    "level": level_name(seconds),
                    "secondsPerTile": seconds,
                    "framesPerTile": max(1, round(seconds * rate)),
                    "sheets": sheets,
                    "frames": frames,
                }
            )
        job.raise_if_cancelled()
        index = {
            "version": INDEX_VERSION,
            "video": True,
            "rate": timebase.rational(rate),
            "tileWidth": tile_width,
            "tileHeight": tile_height,
            "columns": COLUMNS,
            "rows": ROWS,
            "levels": entries,
        }
        publish(output_dir, staging, names, index)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        raise RpcError(OUTPUT_ERROR, "the picture strip could not be written") from None
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {
        "rate": timebase.rational(rate),
        "tileWidth": tile_width,
        "tileHeight": tile_height,
        "columns": COLUMNS,
        "rows": ROWS,
        "index": INDEX_FILE,
        "levels": [
            {key: entry[key] for key in ("level", "secondsPerTile", "framesPerTile", "sheets")} | {"count": len(entry["frames"])}
            for entry in entries
        ],
    }


METHOD = Method(
    "media.filmstrip",
    _filmstrip,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["jobId", "path", "outputDir", "rate"],
        "properties": {
            "jobId": {"type": "string"},
            "path": PATH_SCHEMA,
            "outputDir": PATH_SCHEMA,
            "rate": RATE_SCHEMA,
            "levels": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "items": {"type": "integer", "minimum": 1, "maximum": 3600},
            },
            "tileHeight": {"type": "integer", "minimum": 16, "maximum": 360},
        },
    },
    job=True,
)
