// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { type EditOp, EditOpError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const CLIENT_PUT_MEDIA_REFUSED =
  "Media is added in Assets, not through an edit. Import the file there, or relink it.";

/**
 * The edit.apply RPC needs only operate scope, but `putMedia` can name any file on this machine
 * and the project-media route would then serve it. Media enters only through MediaLibraryService
 * (import, relink), whose RPCs also need filesystem read (S7V-066).
 */
export const refuseClientMediaOps = (ops: ReadonlyArray<EditOp>) => {
  const opIndex = ops.findIndex((op) => op._tag === "putMedia");
  return opIndex === -1
    ? Effect.void
    : Effect.fail(
        new EditOpError({
          opIndex,
          op: "putMedia",
          itemId: null,
          explanation: CLIENT_PUT_MEDIA_REFUSED,
        }),
      );
};
