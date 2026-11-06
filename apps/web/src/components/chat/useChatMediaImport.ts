// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EnvironmentId, MediaImportMode, ProjectId } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";

import { mediaEnvironment } from "../../state/media";
import { useAtomCommand } from "../../state/use-atom-command";
import { explanationOf } from "../editor/mediaErrorExplanation";
import { toastManager } from "../ui/toast";

type DroppedKind = "video" | "audio" | "other";

export function droppedMediaKind(file: Pick<File, "name" | "type">): DroppedKind {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const kind = mediaKindFromPath(file.name);
  return kind === "video" || kind === "audio" ? kind : "other";
}

/**
 * Video and audio dropped in a video project's chat go to Assets by path (S7V-025); audio is also
 * attached for the agent. A failed import toasts with Retry and is never attached in its place
 * (S7V-071). Returns the files to attach; `onFirstMedia` opens the Editor (S7V-029).
 */
export function useChatMediaImport(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  onFirstMedia?: (projectId: ProjectId) => void,
) {
  const plan = useAtomCommand(mediaEnvironment.plan, { reportFailure: false });
  const importMedia = useAtomCommand(mediaEnvironment.importMedia, { reportFailure: false });
  const readEdit = useAtomCommand(mediaEnvironment.readEdit, { reportFailure: false });

  const hasNoMedia = async (projectId: ProjectId) => {
    const edit = await readEdit({ environmentId, input: { projectId } });
    return edit._tag === "Success" && edit.value.document.media.length === 0;
  };

  /** Imports one file; a failure says why, with Retry for that file only. */
  const importOne = async (
    projectId: ProjectId,
    file: File,
    sourcePath: string,
    mode: MediaImportMode,
  ): Promise<boolean> => {
    const result = await importMedia({ environmentId, input: { projectId, sourcePath, mode } });
    if (result._tag === "Success") return true;
    const close = () => toastManager.close(id);
    const id = toastManager.add({
      type: "error",
      title: `Couldn't add ${file.name} to Assets`,
      description: explanationOf(result),
      actionProps: {
        children: "Retry",
        onClick: () => {
          close();
          void retry(projectId, file, sourcePath, mode);
        },
      },
    });
    return false;
  };

  const retry = async (
    projectId: ProjectId,
    file: File,
    sourcePath: string,
    mode: MediaImportMode,
  ) => {
    const firstMedia = await hasNoMedia(projectId);
    if (!(await importOne(projectId, file, sourcePath, mode))) return;
    if (firstMedia) onFirstMedia?.(projectId);
    toastManager.add({ type: "success", title: "Added to Assets" });
  };

  return async (files: ReadonlyArray<File>): Promise<File[]> => {
    const getPath = window.desktopBridge?.getPathForFile;
    const media = files.filter((file) => droppedMediaKind(file) !== "other");
    const paths = media.map((file) => getPath?.(file) ?? "");
    if (projectId === null || media.length === 0 || paths.some((path) => path === "")) {
      return [...files];
    }
    const planned = await plan({ environmentId, input: { projectId, sourcePaths: paths } });
    // Not a video project, or a server on another machine that cannot see these paths.
    if (planned._tag === "Failure") return [...files];
    const firstMedia = await hasNoMedia(projectId);
    let added = 0;
    for (const [index, file] of media.entries()) {
      if (await importOne(projectId, file, paths[index]!, planned.value.suggestedMode)) added += 1;
    }
    if (added > 0 && firstMedia) onFirstMedia?.(projectId);
    if (added > 0) {
      toastManager.add({
        type: "success",
        title: added === 1 ? "Added to Assets" : `Added ${added} files to Assets`,
      });
    }
    return files.filter((file) => droppedMediaKind(file) !== "video");
  };
}
