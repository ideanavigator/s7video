// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The finished export's file, for the Editor's export row (S7V-101): which paths it may name, its
 * size, whether it is still there, and whether the server can show it in Finder.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useProject } from "../state/entities";
import { filesystemEnvironment } from "../state/filesystem";
import { serverEnvironment } from "../state/server";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

/** Only a file in the project's own `exports/` folder: relative, no `..`, no backslash. */
export function isExportPath(path: string): boolean {
  if (!path.startsWith("exports/") || path.includes("\\")) return false;
  const segments = path.split("/");
  return (
    segments.length >= 2 && segments.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function useWorkspaceRoot(projectRef: ScopedProjectRef): string | null {
  return useProject(projectRef)?.workspaceRoot ?? null;
}

/** Whether the server can show a file in Finder, as T3's file menu decides it. */
export function useCanRevealFiles(environmentId: EnvironmentId): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return (
    config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
  );
}

const NO_METADATA = Atom.make(AsyncResult.initial<{ readonly entries: ReadonlyArray<null> }>());

/** The file's size in bytes; `missing` when the server says it is gone; null until known. */
export function useExportFileSize(
  environmentId: EnvironmentId,
  absolutePath: string | null,
): number | "missing" | null {
  const result = useAtomValue(
    absolutePath === null
      ? NO_METADATA
      : filesystemEnvironment.getMetadata({ environmentId, input: { paths: [absolutePath] } }),
  );
  if (!AsyncResult.isSuccess(result)) return null;
  const entry = result.value.entries[0];
  if (entry === null || entry === undefined) return "missing";
  return entry.kind === "file" ? (entry.byteLength ?? null) : "missing";
}

/** Asks the server now: `missing` only when it answers that the file is gone. */
export function useExportFileCheck(environmentId: EnvironmentId) {
  const getMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  return async (absolutePath: string): Promise<"present" | "missing" | "unknown"> => {
    const result = await getMetadata({ environmentId, input: { paths: [absolutePath] } });
    if (result._tag === "Failure") return "unknown";
    const entry = result.value.entries[0];
    return entry !== null && entry !== undefined && entry.kind === "file" ? "present" : "missing";
  };
}

/** "68 MB", or "850 KB" for a short file. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
