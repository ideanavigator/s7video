// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { createMediaEnvironmentAtoms } from "@t3tools/client-runtime/state/media";
import type { MediaLibrarySnapshot, ScopedProjectRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";

export const mediaEnvironment = createMediaEnvironmentAtoms(connectionAtomRuntime);

export type MediaLibraryState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly snapshot: MediaLibrarySnapshot }
  | { readonly _tag: "unavailable" };

const LOADING: MediaLibraryState = { _tag: "loading" };

const mediaLibraryAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): MediaLibraryState => {
    if (ref === null || !get(environmentServerConfigsAtom).has(ref.environmentId)) return LOADING;
    const result = get(
      mediaEnvironment.library({
        environmentId: ref.environmentId,
        input: { projectId: ref.projectId },
      }),
    );
    if (AsyncResult.isSuccess(result)) return { _tag: "ready", snapshot: result.value };
    if (AsyncResult.isFailure(result)) return { _tag: "unavailable" };
    return LOADING;
  }).pipe(Atom.withLabel(`web-media-library:${key}`));
});

/** The project's media, kept live: imports, copies, proxies and edits all update it. Null subscribes to nothing. */
export function useMediaLibrary(ref: ScopedProjectRef | null): MediaLibraryState {
  return useAtomValue(mediaLibraryAtom(ref === null ? "" : scopedProjectKey(ref)));
}

/** The library as last read, for a click handler; loading unless something keeps it subscribed. */
export function readMediaLibrary(ref: ScopedProjectRef): MediaLibraryState {
  return appAtomRegistry.get(mediaLibraryAtom(scopedProjectKey(ref)));
}
