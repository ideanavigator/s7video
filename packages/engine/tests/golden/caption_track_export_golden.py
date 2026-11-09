# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""Golden ``caption-track-export`` (S7V-075): an edit's caption track exports the same captions as
the S7V-046 transcript fallback on the same edit.

``talking-head-01`` cut to 21 ranges at 24000/1001, captioned from its stored transcript. "Add
captions" writes one caption item per uncut run with the words mapped through the cut (the TS
``captionItemsFor``; ``captionWordsParity.test.ts`` keeps it equal to ``map_words``). Checked:

- the ASS file the export writes with the track has exactly the fallback's events;
- the player's stills (``captions.render``) use the same chunks;
- with no caption track the edit still exports transcript captions, as before.

Record a new reference with ``S7VIDEO_GOLDEN_UPDATE=1`` and say why in the PR.
Run with ``pnpm test:golden -- caption-track-export``.
"""

from __future__ import annotations

import hashlib
import json
import os
from fractions import Fraction
from pathlib import Path
from typing import Any

import harness
from export_support import keep_ranges, make_edit

from s7engine import captions_ass, captions_from_words
from s7engine.methods import captions, export

REFERENCE = Path(__file__).parent / "references" / "caption-track-export.json"
TRANSCRIPT = harness.REPO_ROOT / "fixtures" / "media" / "talking-head-01.transcript.json"
UPDATE = os.environ.get("S7VIDEO_GOLDEN_UPDATE") == "1"
RATE = Fraction(24000, 1001)
SOURCE_FRAMES = 3356
SEGMENTS, TOTAL = 21, 1438
WIDTH, HEIGHT = 1080, 1920


def track_items(plan: export.Plan, transcript: dict[str, Any]) -> list[dict[str, Any]]:
    """The caption items "add captions" writes: one per uncut run, words in timeline frames."""
    items = []
    for index, group in enumerate(captions_from_words.map_words(plan.segments, {"cam": transcript}, plan.rate)):
        start, end = group[0].start, max(word.end for word in group)
        items.append(
            {
                "id": f"c{index + 1}",
                "start": start,
                "duration": end - start,
                "text": " ".join(word.text for word in group),
                "words": [{"text": w.text, "start": w.start, "duration": w.end - w.start} for w in group],
            }
        )
    return items


def events(chunks: list[captions_ass.Chunk]) -> list[tuple[int, int, str]]:
    subs = captions_ass.build_ass(chunks, RATE, WIDTH, HEIGHT)
    return [(event.start, event.end, event.text) for event in subs.events]


def test_caption_track_export(media) -> None:
    source = media("talking-head-01")
    stored = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    transcript = {
        "media": "cam",
        "fps": stored["fps"],
        "words": [{key: word[key] for key in ("text", "startFrame", "endFrame")} for word in stored["words"]],
    }
    ranges = keep_ranges(SOURCE_FRAMES, SEGMENTS, TOTAL)
    plain = make_edit(source=source, ranges=ranges, fps=RATE, duration_frames=SOURCE_FRAMES)
    plan = export.plan_segments(plain, WIDTH, HEIGHT)
    params = {"transcripts": [transcript]}

    # A project with no caption track exports transcript captions, as before (S7V-046).
    fallback = export.export_chunks(plain, plan, params)
    assert len(fallback) > 40

    items = track_items(plan, transcript)
    assert len(items) == SEGMENTS
    tracked = make_edit(source=source, ranges=ranges, fps=RATE, duration_frames=SOURCE_FRAMES, captions=items)
    tracked["tracks"][1]["metadata"] = {"s7": {"source": "transcript"}}
    # With the track the transcripts are not used, and the captions are the same.
    with_track = export.export_chunks(tracked, plan, {})
    assert with_track == fallback
    assert events(with_track) == events(fallback)
    # The player's stills show exactly these chunks.
    assert captions.chunks_of(tracked) == fallback

    text = "\n".join(f"{start} {end} {body}" for start, end, body in events(with_track))
    observed = {
        "clip": "talking-head-01",
        "items": len(items),
        "events": len(with_track),
        "eventsSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "first": list(events(with_track)[0]),
        "last": list(events(with_track)[-1]),
    }
    if UPDATE:
        REFERENCE.write_text(json.dumps(observed, indent=2) + "\n", encoding="utf-8")
    assert observed == json.loads(REFERENCE.read_text(encoding="utf-8"))
