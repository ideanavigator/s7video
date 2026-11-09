// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * A chat link to a clip in the project's Media plays it in the Editor instead of the file viewer
 * (S7V-076). Any other file, and any project that is not a video project, opens as before.
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { MediaAsset, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";
import { readProject, readThreadShell } from "../state/entities";
import { readMediaLibrary } from "../state/media";
import { readProjectEdit, rememberPlayerFrame, useEditPlayerStore } from "./editStore";

const isAbsolute = (path: string) => path.startsWith("/");
const trimSlashes = (path: string) => path.replace(/\/+$/u, "");

/** The Media item a linked path names: a copy by its project-relative path, a link by its own. */
export function mediaClipForPath(
  items: ReadonlyArray<MediaAsset>,
  path: string,
  workspaceRoot: string | null,
): MediaAsset | undefined {
  const root = workspaceRoot === null ? null : trimSlashes(workspaceRoot);
  const cleaned = path.replace(/^\.\//u, "");
  const relative =
    root !== null && cleaned.startsWith(`${root}/`)
      ? cleaned.slice(root.length + 1)
      : isAbsolute(cleaned)
        ? null
        : cleaned;
  const absolute = isAbsolute(cleaned)
    ? cleaned
    : root === null
      ? null
      : `${root}/${relative ?? cleaned}`;
  return items.find((item) =>
    item.storage === "copy" ? item.location === relative : item.location === absolute,
  );
}

/** Plays the linked clip in the thread's Editor when it is in Media; false leaves the click as it was. */
export function openMediaLinkInEditor(threadRef: ScopedThreadRef, path: string): boolean {
  const projectId = readThreadShell(threadRef)?.projectId;
  if (projectId === undefined) return false;
  const projectRef = { environmentId: threadRef.environmentId, projectId };
  if (readProjectEdit(projectRef)._tag !== "ready") return false;
  const library = readMediaLibrary(projectRef);
  if (library._tag !== "ready") return false;
  const clip = mediaClipForPath(
    library.snapshot.items,
    path,
    readProject(projectRef)?.workspaceRoot ?? null,
  );
  if (clip === undefined) return false;
  const projectKey = scopedProjectKey(projectRef);
  rememberPlayerFrame(projectKey, 0);
  useEditPlayerStore.getState().setSource(projectKey, { kind: "clip", mediaId: clip.id });
  useRightPanelStore.getState().openEditor(threadRef, projectId);
  return true;
}
