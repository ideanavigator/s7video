// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The rule for an `edit.json` written outside the edit service (S7V-054): it is kept only when it
 * is valid and names no media file the last accepted edit did not name. New media enter only
 * through import or relink, which check the file; an outside write could point anywhere on the Mac.
 */
import type { EditDocument, EditMedia } from "@t3tools/contracts";

/** Where a media entry's file is, as one absolute path: `path` resolved in the project. */
export type LocateMedia = (media: EditMedia) => string;

/**
 * The entries of `next` whose file `previous` did not name. Locations are compared after
 * resolving, so `assets/a.mov` and a reference to the same file in the project are one file.
 */
export const newOutsideMedia = (
  previous: EditDocument,
  next: EditDocument,
  locate: LocateMedia,
): ReadonlyArray<EditMedia> => {
  const known = new Set(previous.media.map(locate));
  return next.media.filter((media) => !known.has(locate(media)));
};

const OUTSIDE_PROBLEM = {
  media: "pointed at a file that was not added through Assets or chat",
  invalid: "could not be read",
} as const;

/**
 * The plain reason an outside change was refused. `start`: a project never changed through the
 * app goes back to how it started, not to a saved version.
 */
export const outsideRefused = (problem: keyof typeof OUTSIDE_PROBLEM, backTo: "saved" | "start") =>
  `The edit was changed outside the app and ${OUTSIDE_PROBLEM[problem]}. That change was not kept; ${
    backTo === "saved"
      ? "the edit is back to its last saved version."
      : "the edit is back to how it started, with nothing in it yet."
  }`;
