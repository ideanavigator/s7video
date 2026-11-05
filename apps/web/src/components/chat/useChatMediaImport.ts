// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";

import { mediaEnvironment } from "../../state/media";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

type DroppedKind = "video" | "audio" | "other";

export function droppedMediaKind(file: Pick<File, "name" | "type">): DroppedKind {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const kind = mediaKindFromPath(file.name);
  return kind === "video" || kind === "audio" ? kind : "other";
}

/**
 * Video and audio dropped into a video project's chat go to its Assets by path, so footage never
 * meets the 50 MiB chat upload limit (S7V-025). Audio is attached as well, so the agent sees it in
 * the message; video is not. Elsewhere (no desktop path, not a video project) nothing changes.
 * Returns the files the composer should still attach; `onFirstMedia` opens the Editor (S7V-029).
 */
export function useChatMediaImport(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  onFirstMedia?: (projectId: ProjectId) => void,
) {
  const plan = useAtomCommand(mediaEnvironment.plan, { reportFailure: false });
  const importMedia = useAtomCommand(mediaEnvironment.importMedia, { reportFailure: false });
  const readEdit = useAtomCommand(mediaEnvironment.readEdit, { reportFailure: false });
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
    const before = await readEdit({ environmentId, input: { projectId } });
    const firstMedia = before._tag === "Success" && before.value.document.media.length === 0;
    const failedVideo: File[] = [];
    let added = 0;
    for (const [index, file] of media.entries()) {
      const result = await importMedia({
        environmentId,
        input: { projectId, sourcePath: paths[index]!, mode: planned.value.suggestedMode },
      });
      if (result._tag === "Success") added += 1;
      else if (droppedMediaKind(file) === "video") failedVideo.push(file);
    }
    if (added > 0 && firstMedia) onFirstMedia?.(projectId);
    if (added > 0) {
      toastManager.add({
        type: "success",
        title: added === 1 ? "Added to Assets" : `Added ${added} files to Assets`,
      });
    }
    return files.filter((file) => droppedMediaKind(file) !== "video" || failedVideo.includes(file));
  };
}
