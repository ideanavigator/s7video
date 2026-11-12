# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`export.render`: ``edit.json`` → an MP4 with burned-in captions, as a job (S7V-028, ADR-007).

Three FFmpeg runs, all cancellable and reporting progress:

1. **measure**: the edit's audio mix alone through ``ebur128``, for its integrated loudness (the
   voice joined from the video track, plus sound effects and music, S7V-036 ``mix.py``);
2. **render**: one pass that trims and joins the original sources frame-exactly, fades the audio
   for 10 ms on each side of every join (inside the kept range, so no cut moves), zooms the items
   that have a punch-in (S7V-037, ``zoom.py``), applies one fixed gain to −14 LUFS with a limiter
   only at the ceiling, burns the captions in with libass in the edit's look after the zoom, so
   captions never zoom, and encodes with ``h264_videotoolbox`` + AAC into an MP4 with ``+faststart``;
3. **check**: ``ebur128`` on the finished file, so the result reports what was really written.

Frames: each source goes through ``fps=<edit rate>`` first, so frame ``n`` of the filter stream is
document frame ``n`` (VFR sources are mapped by their timestamps) and ``trim`` cuts on frame
counts. Audio is cut on the same timestamps and padded or trimmed to the exact sample count of the
cumulative frame boundaries, so audio and video never drift apart.

The render writes ``<output>.part`` and renames it on success; a cancel or failure deletes it.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from .. import captions_ass, captions_from_words, mix, timebase
from ..edit_schema import validate_edit_document
from ..ffmpeg import _tool_env, ffprobe_json, run_tool, tool_path
from ..jobs import Cancelled, JobContext
from ..rpc import FILE_NOT_FOUND, INVALID_PARAMS, MEDIA_ERROR, MISSING_TOOL, OUTPUT_ERROR, Method, RpcError
from ..zoom import Zoom, filters as zoom_filters
from ._media import PATH_SCHEMA, media_file

SAMPLE_RATE = 48_000
TARGET_LUFS = -14.0
# Below this the mix is silence or room noise: leave it as it is rather than lift the noise floor.
QUIET_LUFS = -50.0
MAX_GAIN_DB = 30.0
# Sample-peak ceiling; 0.5 dB under the −1.0 dBTP target leaves room for inter-sample peaks.
LIMIT_DBFS = -1.5
FADE_SECONDS = Fraction(1, 100)
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
REFERENCE_BITRATE = 12_000_000  # 1080×1920 at 30 fps; scaled by pixels per second.

_STAGES = (("measure", 0.0, 0.1), ("render", 0.1, 0.97), ("check", 0.97, 1.0))


# --- Capabilities ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Capabilities:
    libass: bool
    videotoolbox: bool
    zscale: bool
    major: int


_CAPABILITIES: dict[tuple[str, int], Capabilities] = {}
_CAPABILITIES_LOCK = threading.Lock()


def capabilities(job: JobContext) -> Capabilities:
    """What the developer's (or the bundled) FFmpeg can do, read once per binary."""
    path = tool_path("ffmpeg")
    key = (path, os.stat(path).st_mtime_ns)
    with _CAPABILITIES_LOCK:
        if key in _CAPABILITIES:
            return _CAPABILITIES[key]
    filters = run_tool("ffmpeg", ["-hide_banner", "-filters"], job).decode(errors="replace")
    encoders = run_tool("ffmpeg", ["-hide_banner", "-encoders"], job).decode(errors="replace")
    version = run_tool("ffmpeg", ["-hide_banner", "-version"], job).decode(errors="replace")
    match = re.search(r"ffmpeg version n?(\d+)", version)

    def has_filter(name: str) -> bool:
        return re.search(rf"^\s*\S+\s+{name}\s", filters, re.MULTILINE) is not None

    found = Capabilities(
        libass=has_filter("subtitles"),
        videotoolbox=re.search(r"^\s*V\S*\s+h264_videotoolbox\s", encoders, re.MULTILINE) is not None,
        zscale=has_filter("zscale") and has_filter("tonemap"),
        major=int(match.group(1)) if match else 0,
    )
    with _CAPABILITIES_LOCK:
        _CAPABILITIES[key] = found
    return found


def _require(present: bool, feature: str, purpose: str) -> None:
    if not present:
        raise RpcError(MISSING_TOOL, f"ffmpeg has no {feature}, which is needed {purpose}", {"tool": "ffmpeg", "feature": feature})


# --- The plan ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Source:
    path: str
    #: Seconds from the container start (FFmpeg's time origin) to the first video frame.
    video_offset: Fraction
    has_audio: bool
    hdr: bool
    #: No colour matrix tag: read as Rec.709 (media-standards.md), not swscale's BT.601 default.
    untagged_matrix: bool = False


@dataclass(frozen=True)
class Segment:
    """One stretch of the output: a source range, or black and silence for a gap."""

    timeline_start: int
    frames: int
    media: str | None = None
    source_in: int = 0
    gain_db: float = 0.0
    muted: bool = False
    zoom: Zoom | None = None


@dataclass
class Plan:
    rate: Fraction
    width: int
    height: int
    total_frames: int
    segments: list[Segment]
    sources: dict[str, Source] = field(default_factory=dict)
    #: Sound effects and music that play, in track order (S7V-036).
    audio: list[mix.AudioItem] = field(default_factory=list)

    def sample_at(self, frame: int) -> int:
        """The audio sample where timeline frame ``frame`` starts; cumulative, so it never drifts."""
        return mix.sample_at(frame, self.rate)


def _unsupported(what: str) -> RpcError:
    return RpcError(INVALID_PARAMS, f"export cannot draw {what} yet")


def plan_segments(edit: dict[str, Any], width: int, height: int) -> Plan:
    """The output's segments from the edit's first video track, with black gaps between items, and
    the sound effect and music items that play over them."""
    rate = timebase.from_rational(edit["fps"])
    video_tracks = [track for track in edit["tracks"] if track["kind"] == "video"]
    for track in video_tracks[1:]:
        if track["items"] and not track.get("muted"):
            raise _unsupported("a second video track")
    for track in edit["tracks"]:
        if track["kind"] == "overlay" and track["items"] and not track.get("muted"):
            raise _unsupported(f"{track['kind']} tracks")
    items = sorted(video_tracks[0]["items"], key=lambda item: item["start"]) if video_tracks else []
    if not items:
        raise RpcError(INVALID_PARAMS, "the edit has no video to export")
    media = {entry["id"]: entry for entry in edit["media"]}
    segments: list[Segment] = []
    at = 0
    for item in items:
        if media[item["media"]]["kind"] != "video" or not media[item["media"]]["probe"].get("hasVideo"):
            raise _unsupported("an image or audio file on the video track")
        if item["start"] > at:
            segments.append(Segment(at, item["start"] - at))
        segments.append(
            Segment(
                timeline_start=item["start"],
                frames=item["duration"],
                media=item["media"],
                source_in=item["in"],
                gain_db=float(item.get("gainDb", 0.0)),
                muted=bool(item.get("muted")) or bool(video_tracks[0].get("muted")),
                zoom=Zoom.from_edit(item.get("zoom")),
            )
        )
        at = item["start"] + item["duration"]
    audio = mix.audio_items(edit, at)
    for entry in audio:
        source = media[entry.media]
        if source["kind"] == "image" or not source["probe"].get("hasAudio"):
            raise RpcError(INVALID_PARAMS, f'media "{entry.media}" on a sound track has no sound')
    return Plan(rate, width, height, at, segments, audio=audio)


def _checked_style(style_id: str) -> str:
    try:
        captions_ass.load_style(style_id)
    except captions_ass.CaptionStyleError as error:
        raise RpcError(INVALID_PARAMS, str(error)) from None
    return style_id


def caption_items(edit: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for track in edit["tracks"]:
        if track["kind"] != "caption" or track.get("muted"):
            continue
        for item in track["items"]:
            _checked_style(item.get("style") or track.get("style") or captions_ass.DEFAULT_STYLE)
            items.append(item)
    return items


def caption_style(edit: dict[str, Any]) -> str:
    """The edit's one caption look (S7V-037): the style of the first shown caption track with items,
    else of a caption track that names one (the transcript track before its clips have words)."""
    tracks = [track for track in edit["tracks"] if track["kind"] == "caption" and not track.get("muted")]
    shown = [track for track in tracks if track["items"]] or tracks
    style = next((track["style"] for track in shown if track.get("style")), captions_ass.DEFAULT_STYLE)
    return _checked_style(style)


def has_caption_items(edit: dict[str, Any]) -> bool:
    """Any caption item, even on a muted track: a muted caption track means no captions."""
    return any(track["items"] for track in edit["tracks"] if track["kind"] == "caption")


def export_chunks(edit: dict[str, Any], plan: Plan, params: dict[str, Any]) -> list[captions_ass.Chunk]:
    """The edit's caption items win; with none, the clips' transcripts give the captions (S7V-046).

    Either way they are chunked by the rules of the edit's look (``caption_style``).
    """
    style = caption_style(edit)
    if has_caption_items(edit) or not params.get("transcripts"):
        return captions_ass.caption_chunks(caption_items(edit), plan.rate, plan.total_frames, style)
    transcripts = {entry["media"]: entry for entry in params["transcripts"]}
    return captions_from_words.transcript_chunks(plan.segments, transcripts, plan.rate, plan.total_frames, style)


# --- Filter graph ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Input:
    media: str
    #: Seconds of the file to read; the decoder stops after the last frame any segment needs.
    read_seconds: Fraction


def assign_inputs(plan: Plan) -> tuple[list[Input], list[int | None]]:
    """One input per in-order run of a source; going back in a source opens it again.

    Branches of one input share its decoder through ``split``, which buffers every frame a later
    branch needs before the current branch ends. In source order nothing waits; out of order a
    whole stretch of decoded frames would sit in memory.
    """
    inputs: list[Input] = []
    reach: list[int] = []
    current: dict[str, int] = {}
    assignment: list[int | None] = []
    for segment in plan.segments:
        if segment.media is None:
            assignment.append(None)
            continue
        index = current.get(segment.media)
        if index is None or segment.source_in < reach[index]:
            index = len(inputs)
            inputs.append(Input(segment.media, Fraction(0)))
            reach.append(0)
            current[segment.media] = index
        reach[index] = segment.source_in + segment.frames
        assignment.append(index)
    for index, entry in enumerate(inputs):
        offset = plan.sources[entry.media].video_offset if entry.media in plan.sources else Fraction(0)
        inputs[index] = Input(entry.media, offset + Fraction(reach[index]) / plan.rate + 1)
    return inputs, assignment


def _rate(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


def _seconds(value: Fraction) -> str:
    return timebase.decimal_seconds(value)


def _video_chain(plan: Plan, source: Source | None, punch_in: Zoom | None = None) -> str:
    tonemap = (
        "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
        "zscale=t=bt709:m=bt709:r=tv,"
        if source is not None and source.hdr
        else ""
    )
    untagged = ":in_color_matrix=bt709" if source is not None and source.untagged_matrix and not source.hdr else ""
    # The zoom works on the canvas-sized frame, so its anchor is a point of what the viewer sees.
    zoomed = zoom_filters(plan.width, plan.height, punch_in) if punch_in is not None else ""
    return (
        f"{tonemap}scale={plan.width}:{plan.height}:force_original_aspect_ratio=increase{untagged}"
        f":out_color_matrix=bt709:out_range=tv,crop={plan.width}:{plan.height},"
        f"{zoomed + ',' if zoomed else ''}setsar=1,format=yuv420p"
    )


def _audio_chain(samples: int, segment: Segment) -> str:
    fade = min(round(FADE_SECONDS * SAMPLE_RATE), samples // 2)
    gain = f"volume={segment.gain_db}dB," if segment.gain_db else ""
    fades = f",afade=t=in:ns={fade},afade=t=out:ss={samples - fade}:ns={fade}" if fade > 0 else ""
    return (
        f"asetpts=PTS-STARTPTS,{gain}aformat=sample_rates={SAMPLE_RATE}:channel_layouts=stereo,"
        f"apad=whole_len={samples},atrim=end_sample={samples}{fades}"
    )


def build_graph(plan: Plan, inputs: list[Input], assignment: list[int | None], *, video: bool, ass_file: str | None) -> str:
    """The filter graph; ``video=False`` gives the audio mix alone, for the loudness measurement.

    Outputs ``[vout]`` (when ``video``) and ``[amix]``, the mix before the loudness gain. Sound
    effects and music read the inputs after ``inputs``, one each, in ``plan.audio`` order.
    """
    chains: list[str] = []
    uses: dict[int, list[int]] = {}
    for position, index in enumerate(assignment):
        if index is not None:
            uses.setdefault(index, []).append(position)
    for index, positions in uses.items():
        source = plan.sources[inputs[index].media]
        count = len(positions)
        if video:
            labels = "".join(f"[v{position}]" for position in positions)
            chains.append(f"[{index}:v:0]fps={_rate(plan.rate)},split={count}{labels}")
        audible = [position for position in positions if not plan.segments[position].muted]
        if source.has_audio and audible:
            labels = "".join(f"[a{position}]" for position in audible)
            chains.append(f"[{index}:a:0]aresample={SAMPLE_RATE},asplit={len(audible)}{labels}")
    joined: list[str] = []
    for position, segment in enumerate(plan.segments):
        samples = plan.sample_at(segment.timeline_start + segment.frames) - plan.sample_at(segment.timeline_start)
        index = assignment[position]
        source = plan.sources[segment.media] if segment.media is not None else None
        if video:
            if index is None:
                chains.append(
                    f"color=c=black:s={plan.width}x{plan.height}:r={_rate(plan.rate)},"
                    f"trim=end_frame={segment.frames},format=yuv420p[vs{position}]"
                )
            else:
                chains.append(
                    f"[v{position}]trim=start_frame={segment.source_in}:end_frame={segment.source_in + segment.frames},"
                    f"setpts=PTS-STARTPTS,{_video_chain(plan, source, segment.zoom)}[vs{position}]"
                )
        if source is not None and source.has_audio and not segment.muted:
            start = source.video_offset + Fraction(segment.source_in) / plan.rate
            end = start + Fraction(segment.frames) / plan.rate
            chains.append(
                f"[a{position}]atrim=start={_seconds(start)}:end={_seconds(end)},{_audio_chain(samples, segment)}[as{position}]"
            )
        else:
            chains.append(
                f"anullsrc=r={SAMPLE_RATE}:cl=stereo,atrim=end_sample={samples},aformat=sample_fmts=fltp[as{position}]"
            )
        joined.append(f"[vs{position}][as{position}]" if video else f"[as{position}]")
    count = len(plan.segments)
    voice = "[voice]" if plan.audio else "[amix]"
    if video:
        chains.append(f"{''.join(joined)}concat=n={count}:v=1:a=1[vcat]{voice}")
        captions = f"subtitles=filename={ass_file}:fontsdir=fonts," if ass_file else ""
        # concat hands out microsecond timestamps with no frame duration, and the MP4 muxer then
        # drops the last frame of some sources: renumber on the edit's own time base. The tags go
        # on the frames, since the encoder takes colour from them, not from the output flags.
        chains.append(
            f"[vcat]settb=expr={plan.rate.denominator}/{plan.rate.numerator},setpts=N,{captions}"
            "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p[vout]"
        )
    else:
        chains.append(f"{''.join(joined)}concat=n={count}:v=0:a=1{voice}")
    if plan.audio:
        chains += mix.mix_chains(plan.audio, len(inputs), plan.rate, plan.total_frames)
    return ";\n".join(chains)


# --- Loudness ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Gain:
    measured_lufs: float
    gain_db: float


def fixed_gain(measured_lufs: float) -> Gain:
    """One constant gain to −14 LUFS; quiet or silent mixes are left alone."""
    if not math.isfinite(measured_lufs) or measured_lufs <= QUIET_LUFS:
        return Gain(measured_lufs, 0.0)
    gain = max(-MAX_GAIN_DB, min(MAX_GAIN_DB, TARGET_LUFS - measured_lufs))
    return Gain(measured_lufs, round(gain, 2))


def loudness_chain(gain: Gain) -> str:
    limit = 10 ** (LIMIT_DBFS / 20)
    volume = f"volume={gain.gain_db}dB," if gain.gain_db else ""
    # level=0: no auto-levelling (it would pump); latency=1: compensates the attack lookahead, so the
    # limiter adds no delay and sync holds.
    return f"{volume}alimiter=limit={limit:.4f}:level=0:latency=1:attack=5:release=50"


_SUMMARY = re.compile(r"Summary:(.*)", re.DOTALL)


def parse_ebur128(stderr: str) -> tuple[float, float]:
    """Integrated loudness and true peak from FFmpeg's ``ebur128`` summary."""
    match = _SUMMARY.search(stderr)
    if match is None:
        raise RpcError(MEDIA_ERROR, "the loudness measurement failed")
    summary = match.group(1)

    def grab(label: str) -> float:
        found = re.search(rf"{label}:\s+(-?[0-9.]+|-inf)\s", summary)
        if found is None:
            raise RpcError(MEDIA_ERROR, "the loudness measurement failed")
        return float(found.group(1))

    return grab("I"), grab("Peak")


# --- Running FFmpeg ----------------------------------------------------------------------------


def parse_progress(line: str, total_seconds: Fraction) -> float | None:
    """A ``-progress`` line → 0..1 of the output written, or None for other keys."""
    key, _, value = line.strip().partition("=")
    if key not in ("out_time_us", "out_time_ms") or not value.lstrip("-").isdigit() or total_seconds <= 0:
        return None
    # FFmpeg's out_time_ms is microseconds too (a long-standing misnomer).
    return max(0.0, min(1.0, float(Fraction(int(value), 1_000_000) / total_seconds)))


@dataclass
class _Run:
    stderr_tail: str
    returncode: int


def _ffmpeg(args: list[str], job: JobContext, cwd: str, total_seconds: Fraction, report: Callable[[float], None]) -> _Run:
    """Runs FFmpeg with ``-progress pipe:1``; a cancel kills this process (and only this one)."""
    process = subprocess.Popen(
        [tool_path("ffmpeg"), "-nostdin", "-hide_banner", "-nostats", "-progress", "pipe:1", "-stats_period", "0.25", *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=_tool_env(),
    )
    stop = process.kill
    job.on_cancel(stop)
    tail: list[str] = []

    def drain() -> None:
        assert process.stderr is not None
        kept = 0
        for raw in process.stderr:
            line = raw.decode(errors="replace")
            tail.append(line)
            kept += len(line)
            while kept > 65_536 and len(tail) > 1:
                kept -= len(tail.pop(0))

    reader = threading.Thread(target=drain, name="s7engine-ffmpeg-stderr", daemon=True)
    reader.start()
    try:
        assert process.stdout is not None
        for raw in process.stdout:
            value = parse_progress(raw.decode(errors="replace"), total_seconds)
            if value is not None and not job.cancelled:
                report(value)
        process.wait()
        reader.join()
    finally:
        job.remove_on_cancel(stop)
        if process.poll() is None:
            process.kill()
            process.wait()
    if job.cancelled:
        raise Cancelled()
    return _Run("".join(tail), process.returncode)


def _failed(run: _Run, what: str) -> RpcError:
    if "No space left on device" in run.stderr_tail:
        return RpcError(OUTPUT_ERROR, "there is not enough free disk space for the export")
    return RpcError(MEDIA_ERROR, f"ffmpeg could not {what}")


# --- The method --------------------------------------------------------------------------------


def _probe_source(path: str, job: JobContext) -> Source:
    info = ffprobe_json(
        [
            "-show_entries",
            "format=start_time:stream=index,codec_type,start_pts,time_base,color_transfer,color_space"
            ":stream_disposition=attached_pic",
            path,
        ],
        job,
    )
    streams = info.get("streams") or []
    video = next(
        (s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")),
        None,
    )
    if video is None:
        raise RpcError(MEDIA_ERROR, "a video in the edit has no video stream")
    time_base = timebase.parse_rational(video.get("time_base")) or Fraction(0)
    try:
        container_start = Fraction((info.get("format") or {}).get("start_time") or "0")
        video_start = int(video.get("start_pts") or 0) * time_base
    except (TypeError, ValueError):
        container_start = video_start = Fraction(0)
    return Source(
        path=path,
        video_offset=max(Fraction(0), video_start - container_start),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        hdr=video.get("color_transfer") in HDR_TRANSFERS,
        untagged_matrix=video.get("color_space") in (None, "", "unknown"),
    )


def _media_path(entry: dict[str, Any], project_dir: str) -> str:
    if entry.get("reference") is not None:
        path = entry["reference"]
    else:
        root = os.path.realpath(project_dir)
        path = os.path.realpath(os.path.join(root, entry["path"]))
        if os.path.commonpath([root, path]) != root:
            raise RpcError(INVALID_PARAMS, f'media "{entry["id"]}" is outside the project')
    try:
        media_file(path)
    except RpcError:
        raise RpcError(FILE_NOT_FOUND, f'media "{entry["id"]}" is missing') from None
    return path


def _bitrate(plan: Plan) -> int:
    pixels = plan.width * plan.height * plan.rate
    value = REFERENCE_BITRATE * pixels / (1080 * 1920 * 30)
    return int(max(2_000_000, min(40_000_000, value)))


def _check_output(output: str, plan: Plan) -> str:
    if not os.path.isabs(output) or not output.endswith(".mp4"):
        raise RpcError(INVALID_PARAMS, "invalid params at outputPath: must be an absolute .mp4 path")
    folder = os.path.dirname(output)
    if not os.path.isdir(folder):
        raise RpcError(OUTPUT_ERROR, "the exports folder does not exist")
    if os.path.exists(output):
        raise RpcError(OUTPUT_ERROR, "an export with this name already exists")
    if os.path.exists(f"{output}.part"):
        raise RpcError(OUTPUT_ERROR, "an export with this name is already being written")
    seconds = Fraction(plan.total_frames) / plan.rate
    needed = (_bitrate(plan) + 256_000) * seconds / 8 * Fraction(5, 4)
    if shutil.disk_usage(folder).free < needed:
        raise RpcError(OUTPUT_ERROR, "there is not enough free disk space for the export")
    return f"{output}.part"


def _stage(job: JobContext, name: str) -> Callable[[float], None]:
    _, low, high = next(stage for stage in _STAGES if stage[0] == name)
    job.progress(low, name)

    def report(value: float) -> None:
        job.progress(low + (high - low) * value, name)

    return report


def _render(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    edit = params["edit"]
    issues = validate_edit_document(edit)
    if issues:
        raise RpcError(INVALID_PARAMS, f"the edit is not valid: {issues[0].explanation}")
    canvas = params.get("canvas") or edit["canvas"]
    width, height = int(canvas["width"]), int(canvas["height"])
    if width % 2 or height % 2:
        raise RpcError(INVALID_PARAMS, "invalid params at canvas: width and height must be even")
    plan = plan_segments(edit, width, height)
    output = params["outputPath"]
    project_dir = params["projectDir"]
    if not os.path.isabs(project_dir):
        raise RpcError(INVALID_PARAMS, "invalid params at projectDir: must be absolute")
    partial = _check_output(output, plan)

    chunks = export_chunks(edit, plan, params) if params.get("captions", True) else []
    caps = capabilities(job)
    _require(caps.videotoolbox, "h264_videotoolbox", "to encode the video with the Mac's hardware")
    if chunks:
        _require(caps.libass, "libass", "to burn in captions")

    media = {entry["id"]: entry for entry in edit["media"]}
    for media_id in {segment.media for segment in plan.segments if segment.media is not None}:
        plan.sources[media_id] = _probe_source(_media_path(media[media_id], project_dir), job)
    if any(source.hdr for source in plan.sources.values()):
        _require(caps.zscale, "zscale", "to convert HDR video to standard range")
    inputs, assignment = assign_inputs(plan)
    input_args: list[str] = []
    for entry in inputs:
        input_args += ["-t", _seconds(entry.read_seconds), "-i", plan.sources[entry.media].path]
    for item in plan.audio:
        input_args += ["-t", _seconds(mix.read_seconds(item, plan.rate)), "-i", _media_path(media[item.media], project_dir)]
    total_seconds = Fraction(plan.total_frames) / plan.rate
    script_flag = "-/filter_complex" if caps.major >= 7 else "-filter_complex_script"

    # Claimed with O_EXCL: a second job given the same name is refused here, never shares the file.
    try:
        os.close(os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644))
    except FileExistsError:
        raise RpcError(OUTPUT_ERROR, "an export with this name is already being written") from None
    except OSError:
        raise RpcError(OUTPUT_ERROR, "the export file cannot be created") from None
    job.track_output(partial)

    workdir = tempfile.mkdtemp(prefix="s7export-")
    try:
        # 1. Measure the mix.
        with open(os.path.join(workdir, "measure.txt"), "w", encoding="utf-8") as file:
            file.write(build_graph(plan, inputs, assignment, video=False, ass_file=None))
            file.write(";\n[amix]ebur128=peak=true:framelog=quiet[ameasured]")
        run = _ffmpeg(
            [*input_args, script_flag, "measure.txt", "-map", "[ameasured]", "-f", "null", "-"],
            job,
            workdir,
            total_seconds,
            _stage(job, "measure"),
        )
        if run.returncode != 0:
            raise _failed(run, "read the edit's audio")
        gain = fixed_gain(parse_ebur128(run.stderr_tail)[0])

        # 2. Render.
        ass_file = None
        if chunks:
            ass_file = "captions.ass"
            captions_ass.write_ass(os.path.join(workdir, ass_file), chunks, plan.rate, width, height, caption_style(edit))
            captions_ass.link_fonts(Path(workdir) / "fonts")
        with open(os.path.join(workdir, "render.txt"), "w", encoding="utf-8") as file:
            file.write(build_graph(plan, inputs, assignment, video=True, ass_file=ass_file))
            file.write(f";\n[amix]{loudness_chain(gain)}[aout]")
        bitrate = _bitrate(plan)
        run = _ffmpeg(
            [
                *input_args,
                script_flag,
                "render.txt",
                "-map",
                "[vout]",
                "-map",
                "[aout]",
                "-r",
                _rate(plan.rate),
                "-fps_mode",
                "cfr",
                "-c:v",
                "h264_videotoolbox",
                "-profile:v",
                "high",
                "-allow_sw",
                "0",
                "-b:v",
                str(bitrate),
                "-maxrate",
                str(bitrate * 3 // 2),
                "-bufsize",
                str(bitrate * 2),
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-color_range",
                "tv",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "-y",
                partial,
            ],
            job,
            workdir,
            total_seconds,
            _stage(job, "render"),
        )
        if run.returncode != 0:
            raise _failed(run, "render the export")

        # 3. Check what was written.
        run = _ffmpeg(
            ["-i", partial, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
            job,
            workdir,
            total_seconds,
            _stage(job, "check"),
        )
        if run.returncode != 0:
            raise _failed(run, "read back the export")
        lufs, true_peak = parse_ebur128(run.stderr_tail)
        job.raise_if_cancelled()
        os.replace(partial, output)
        job.keep_output(partial)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return {
        "path": output,
        "durationFrames": plan.total_frames,
        "fps": timebase.rational(plan.rate),
        "width": width,
        "height": height,
        "captions": len(chunks),
        "measuredLufs": gain.measured_lufs if math.isfinite(gain.measured_lufs) else None,
        "gainDb": gain.gain_db,
        "lufs": lufs if math.isfinite(lufs) else None,
        "truePeak": true_peak if math.isfinite(true_peak) else None,
    }


METHOD = Method(
    "export.render",
    _render,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["jobId", "edit", "projectDir", "outputPath"],
        "properties": {
            "jobId": {"type": "string"},
            "edit": {"type": "object"},
            "projectDir": PATH_SCHEMA,
            "outputPath": PATH_SCHEMA,
            "captions": {"type": "boolean"},
            # The clips' cached transcripts (S7V-046), used only when the edit has no caption items.
            "transcripts": {
                "type": "array",
                "maxItems": 256,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["media", "fps", "words"],
                    "properties": {
                        "media": {"type": "string"},
                        "fps": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["num", "den"],
                            "properties": {
                                "num": {"type": "integer", "minimum": 1},
                                "den": {"type": "integer", "minimum": 1},
                            },
                        },
                        "words": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["text", "startFrame", "endFrame"],
                                "properties": {
                                    "text": {"type": "string"},
                                    "startFrame": {"type": "integer", "minimum": 0},
                                    "endFrame": {"type": "integer", "minimum": 0},
                                },
                            },
                        },
                    },
                },
            },
            "canvas": {
                "type": "object",
                "additionalProperties": False,
                "required": ["width", "height"],
                "properties": {
                    "width": {"type": "integer", "minimum": 16, "maximum": 7680},
                    "height": {"type": "integer", "minimum": 16, "maximum": 7680},
                },
            },
        },
    },
    job=True,
)
