// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The video-project layout (S7V-076): a thread in a video project opens with the Editor, unless
 * the user already arranged that thread's panel. Other projects keep T3's layout.
 */
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useMediaLibrary } from "../state/media";
import { useIsVideoProject } from "./editStore";

/** The Editor's default share of the workspace in a video project. */
export const VIDEO_PROJECT_EDITOR_WIDTH_FRACTION = 0.6;

/** Returns whether the thread's project is a video project. Null thread: nothing opens. */
export function useVideoProjectLayout(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectRef: ScopedProjectRef | null;
}): boolean {
  const { threadRef, projectRef } = input;
  const videoProject = useIsVideoProject(projectRef);
  // Keeps Media subscribed while the Editor is closed, so a chat link to a clip finds it.
  useMediaLibrary(videoProject ? projectRef : null);
  const projectId = projectRef?.projectId ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the right panel store's Editor once the server says the project has an edit
  useEffect(() => {
    if (!videoProject || threadRef === null || projectId === null) return;
    useRightPanelStore.getState().openEditorByDefault(threadRef, projectId);
  }, [videoProject, threadRef, projectId]);

  return videoProject;
}
