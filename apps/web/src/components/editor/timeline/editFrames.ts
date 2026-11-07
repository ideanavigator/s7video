// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Player frames and timeline frames (S7V-033). The Engine A player publishes the count of kept
 * frames (`timelineFrameOf` in editPlayback.ts), not the item `start` in `edit.json`. The two are
 * equal for every edit Engine A makes (one source laid end to end from frame 0), so these are the
 * identity. S7V-034 (gaps, reordering) and S7V-039 (several clips) change the mapping here only.
 */

/** The edit frame the timeline shows for a frame the player published. */
export const playerFrameToEditFrame = (playerFrame: number): number => playerFrame;

/** The player frame to seek to for an edit frame clicked on the timeline. */
export const editFrameToPlayerFrame = (editFrame: number): number => editFrame;
