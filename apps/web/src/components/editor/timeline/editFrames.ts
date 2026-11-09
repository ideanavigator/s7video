// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Player frames and timeline frames (S7V-033, S7V-039). Both players publish edit frames at item
 * `start`s: the multi-clip clock by construction, and the Engine A player because the panel gives
 * it only edits whose packed frames equal the starts (`playsAsSingleSource`). The mapping is the
 * identity; a player that ever publishes another frame space changes it here only.
 */
import type { PlayerFramePlan } from "../../../editor/editPlayback";

/** The edit frame the timeline shows for a frame the player of `plan` published. */
export const playerFrameToEditFrame = (
  playerFrame: number,
  _plan: PlayerFramePlan | null,
): number => playerFrame;

/**
 * The player frame to seek to for an edit frame clicked on the timeline, or null when the player
 * cannot show it: no edit plays, or the frame lies past the edit's end. The timeline then moves
 * only its own playhead.
 */
export function editFrameToPlayerFrame(
  editFrame: number,
  plan: PlayerFramePlan | null,
): number | null {
  if (plan === null || editFrame >= plan.durationFrames) return null;
  return editFrame;
}
