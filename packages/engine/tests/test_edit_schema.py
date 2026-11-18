# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""The engine accepts and rejects the shared edit.json fixtures exactly as the TS validator does."""

import json
from pathlib import Path

import pytest

from s7engine.edit_schema import validate_edit_document

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "edit-documents"
CASES = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))["cases"]


def test_has_at_least_twenty_fixtures() -> None:
    assert len(CASES) >= 20
    assert any(case["valid"] for case in CASES) and any(not case["valid"] for case in CASES)


@pytest.mark.parametrize("case", CASES, ids=[case["file"] for case in CASES])
def test_fixture_matches_expected_result(case: dict) -> None:
    raw = json.loads((FIXTURES / case["file"]).read_text(encoding="utf-8"))
    issues = validate_edit_document(raw)
    if case["valid"]:
        assert issues == []
    else:
        assert issues, "expected a validation problem"
        first = issues[0]
        assert (first.reason, first.item_id) == (case["reason"], case["itemId"])
        assert first.explanation


def test_names_the_item_in_plain_words() -> None:
    raw = json.loads((FIXTURES / "11-overlap.json").read_text(encoding="utf-8"))
    [issue] = validate_edit_document(raw)
    assert '"v3"' in issue.explanation and "overlaps" in issue.explanation


def test_rejects_non_finite_frames_without_crashing() -> None:
    raw = json.loads((FIXTURES / "02-single-clip.json").read_text(encoding="utf-8"))
    raw["tracks"][0]["items"][0]["duration"] = float("inf")
    [issue] = validate_edit_document(raw)
    assert (issue.reason, issue.item_id) == ("frame", "v1")


def test_a_zoom_ramp_over_sixty_frames_is_refused_by_name() -> None:
    # S7V-037: the export draws a frame-sized branch per ramp frame, so a ramp is capped.
    raw = json.loads((FIXTURES / "27-zoom-ramp-too-long.json").read_text(encoding="utf-8"))
    [issue] = validate_edit_document(raw)
    assert (issue.reason, issue.item_id) == ("frame", "b1")
    assert issue.explanation == '"b1" has rampFrames 61. A zoom ramps over at most 60 frames.'
    zoomed = next(item for track in raw["tracks"] for item in track["items"] if item["id"] == "b1")
    zoomed["zoom"]["rampFrames"] = 60
    assert validate_edit_document(raw) == []
