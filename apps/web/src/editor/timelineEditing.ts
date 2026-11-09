// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The edit RPCs as the timeline's outcomes (S7V-034): a stale revision is a conflict, an invalid
 * result (an overlap) is refused, and "nothing to undo" is not an error.
 */
import type {
  EditApplyOutcome,
  EditStepOutcome,
} from "../components/editor/timeline/timelineEditor";

const tagOf = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : null;

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

export function applyOutcomeOfError(error: unknown): EditApplyOutcome {
  switch (tagOf(error)) {
    case "EditConflict":
      return { _tag: "conflict" };
    case "EditValidationError":
    case "EditOpError":
      return { _tag: "refused", message: messageOf(error, "That change can't be made.") };
    default:
      return { _tag: "failed", message: messageOf(error, "Check the project, then try again.") };
  }
}

export function stepOutcomeOfError(error: unknown): EditStepOutcome {
  if (
    tagOf(error) === "EditUnavailableError" &&
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    (error.reason === "nothing-to-undo" || error.reason === "nothing-to-redo")
  ) {
    return { _tag: "nothing" };
  }
  return { _tag: "failed", message: messageOf(error, "Check the project, then try again.") };
}
