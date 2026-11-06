// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** The plain reason a media command failed, for a toast; the same text in Assets and in chat. */
export const explanationOf = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string => {
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" && error !== null && "explanation" in error
    ? String(error.explanation)
    : "Check that the project's server is running, then try again.";
};
