# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`media.probe`: container, video and audio facts, with time as rationals and integer frames.

The last frame's PTS comes from reading the final seconds of packets, not from the container's
duration field, so it is the real timestamp of the last frame.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Any

from .. import timebase
from ..ffmpeg import ffprobe_json
from ..jobs import JobContext
from ..rpc import MEDIA_ERROR, Method, RpcError
from ._media import PATH_SCHEMA, media_file

_STREAM_FIELDS = ",".join(
    [
        "index",
        "codec_type",
        "codec_name",
        "profile",
        "width",
        "height",
        "pix_fmt",
        "r_frame_rate",
        "avg_frame_rate",
        "time_base",
        "start_pts",
        "duration_ts",
        "nb_frames",
        "sample_rate",
        "channels",
        "channel_layout",
        "color_space",
        "color_transfer",
        "color_primaries",
        "color_range",
    ]
)
_TAIL = Fraction(3)


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value and value != "unknown" else None


def _rotation(stream: dict[str, Any]) -> int:
    for side_data in stream.get("side_data_list", []) or []:
        rotation = _int(side_data.get("rotation"))
        if rotation is not None:
            return rotation % 360
    return 0


def _last_video_pts(path: str, stream: dict[str, Any], duration: Fraction | None, job: JobContext) -> int | None:
    args = ["-select_streams", str(stream["index"]), "-show_entries", "packet=pts"]
    if duration is not None and duration > _TAIL:
        args += ["-read_intervals", f"{timebase.decimal_seconds(duration - _TAIL)}%"]
    packets = ffprobe_json([*args, path], job).get("packets", [])
    values = [pts for pts in (_int(packet.get("pts")) for packet in packets) if pts is not None]
    return max(values) if values else None


def _counted_frames(path: str, stream: dict[str, Any], job: JobContext) -> int | None:
    args = ["-count_packets", "-select_streams", str(stream["index"]), "-show_entries", "stream=nb_read_packets"]
    streams = ffprobe_json([*args, path], job).get("streams", [])
    return _int(streams[0].get("nb_read_packets")) if streams else None


def _video(path: str, stream: dict[str, Any], duration: Fraction | None, job: JobContext) -> dict[str, Any]:
    rate = timebase.parse_rational(stream.get("r_frame_rate"))
    average = timebase.parse_rational(stream.get("avg_frame_rate")) or rate
    rate = rate or average
    time_base = timebase.parse_rational(stream.get("time_base"))
    if rate is None or time_base is None:
        raise RpcError(MEDIA_ERROR, "the video stream has no frame rate")
    first_pts = _int(stream.get("start_pts")) or 0
    last_pts = _last_video_pts(path, stream, duration, job)
    if last_pts is None:
        raise RpcError(MEDIA_ERROR, "the video stream has no frames")
    frame_count = _int(stream.get("nb_frames")) or _counted_frames(path, stream, job) or 0
    return {
        "index": stream["index"],
        "codec": _text(stream.get("codec_name")) or "unknown",
        "profile": _text(stream.get("profile")),
        "width": _int(stream.get("width")) or 0,
        "height": _int(stream.get("height")) or 0,
        "pixelFormat": _text(stream.get("pix_fmt")),
        "frameRate": timebase.rational(rate),
        "averageFrameRate": timebase.rational(average or rate),
        "variableFrameRate": average is not None and average != rate,
        "timeBase": timebase.rational(time_base),
        "firstPts": first_pts,
        "lastPts": last_pts,
        "frameCount": frame_count,
        "durationFrames": timebase.span_frames(first_pts, last_pts, time_base, rate),
        "rotation": _rotation(stream),
        "color": {
            "space": _text(stream.get("color_space")),
            "transfer": _text(stream.get("color_transfer")),
            "primaries": _text(stream.get("color_primaries")),
            "range": _text(stream.get("color_range")),
        },
    }


def _audio(stream: dict[str, Any], duration: Fraction | None) -> dict[str, Any]:
    sample_rate = _int(stream.get("sample_rate")) or 0
    time_base = timebase.parse_rational(stream.get("time_base")) or Fraction(1, sample_rate or 1)
    duration_ts = _int(stream.get("duration_ts"))
    if duration_ts is not None:
        samples = round(duration_ts * time_base * sample_rate)
    elif duration is not None:
        samples = round(duration * sample_rate)
    else:
        samples = None
    return {
        "index": stream["index"],
        "codec": _text(stream.get("codec_name")) or "unknown",
        "sampleRate": sample_rate,
        "channels": _int(stream.get("channels")) or 0,
        "channelLayout": _text(stream.get("channel_layout")),
        "timeBase": timebase.rational(time_base),
        "firstPts": _int(stream.get("start_pts")) or 0,
        "durationSamples": samples,
    }


def _probe(params: dict[str, Any], job: JobContext) -> dict[str, Any]:
    path = params["path"]
    stat = media_file(path)
    info = ffprobe_json(
        [
            "-show_entries",
            f"format=format_name,size,bit_rate,duration:stream={_STREAM_FIELDS}"
            ":stream_side_data=rotation:stream_disposition=attached_pic",
            path,
        ],
        job,
    )
    container = info.get("format") or {}
    duration_text = container.get("duration")
    try:
        duration = Fraction(duration_text) if isinstance(duration_text, str) else None
    except ValueError:
        duration = None
    streams = info.get("streams") or []
    video_stream = next(
        (
            stream
            for stream in streams
            if stream.get("codec_type") == "video" and not (stream.get("disposition") or {}).get("attached_pic")
        ),
        None,
    )
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if video_stream is None and audio_stream is None:
        raise RpcError(MEDIA_ERROR, "the file has no video or audio")
    video = _video(path, video_stream, duration, job) if video_stream is not None else None
    return {
        "path": path,
        "container": _text(container.get("format_name")) or "unknown",
        "sizeBytes": _int(container.get("size")) or stat.st_size,
        "bitRate": _int(container.get("bit_rate")),
        "durationFrames": video["durationFrames"] if video is not None else None,
        "video": video,
        "audio": _audio(audio_stream, duration) if audio_stream is not None else None,
    }


METHOD = Method(
    "media.probe",
    _probe,
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["path"],
        "properties": {"path": PATH_SCHEMA},
    },
)
