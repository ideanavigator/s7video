// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Player frames and timeline frames (S7V-033). The Engine A player publishes the count of kept
 * frames of its plan (`timelineFrameOf` in editPlayback.ts), not the item `start` in `edit.json`.
 * For every edit Engine A makes (one source laid end to end from frame 0) the two are equal.
 * S7V-034 (gaps, reordering) and S7V-039 (several clips) change the mapping here only.
 */
import type { PlaybackPlan } from "../../../editor/editPlayback";

/** The edit frame the timeline shows for a frame the player of `plan` published. */
export const playerFrameToEditFrame = (playerFrame: number, _plan: PlaybackPlan | null): number =>
  playerFrame;

/**
 * The player frame to seek to for an edit frame clicked on the timeline, or null when the player
 * cannot show it: no edit plays, or the frame lies past what the plan plays (other clips, which
 * play from S7V-039). The timeline then moves only its own playhead.
 */
export function editFrameToPlayerFrame(
  editFrame: number,
  plan: PlaybackPlan | null,
): number | null {
  if (plan === null || editFrame >= plan.durationFrames) return null;
  return editFrame;
}
