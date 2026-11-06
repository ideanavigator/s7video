// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * When a video tool tells the agent the speech model is missing, the Editor panel opens for the
 * thread's project so its download prompt is in view (S7V-067). It opens the panel only; the
 * download still waits for the user's press.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { MODELS_MISSING_MESSAGE, type ScopedThreadRef } from "@t3tools/contracts";
import { DateTime } from "effect";
import { useEffect, useRef } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useSpeechModelRequests } from "./editStore";
import { isVideoToolName } from "./videoTools";

const mentionsMissingModel = (output: unknown) => {
  if (output === undefined || output === null) return false;
  if (typeof output === "string") return output.includes(MODELS_MISSING_MESSAGE);
  try {
    return JSON.stringify(output).includes(MODELS_MISSING_MESSAGE);
  } catch {
    return false;
  }
};

interface ModelsMissingCall {
  readonly id: string;
  readonly updatedAtMillis: number;
}

/** The thread's video tool calls that answered "the speech model is missing". */
function modelsMissingCalls(
  rows: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): ModelsMissingCall[] {
  return rows.flatMap(({ item }) =>
    item.type === "dynamic_tool" &&
    isVideoToolName(item.toolName) &&
    mentionsMissingModel(item.output)
      ? [{ id: item.id, updatedAtMillis: DateTime.toEpochMillis(item.updatedAt) }]
      : [],
  );
}

export interface ModelsMissingWatch {
  readonly threadKey: string;
  readonly seen: ReadonlySet<string>;
  /** The newest item when the thread was first read: older calls (history) never open the panel. */
  readonly watermarkMillis: number;
}

/** Calls that are new since the watch began; the first read of a thread only sets the watch. */
export function observeModelsMissing(
  previous: ModelsMissingWatch | null,
  threadKey: string,
  rows: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): { readonly watch: ModelsMissingWatch; readonly fresh: boolean } {
  const calls = modelsMissingCalls(rows);
  if (previous === null || previous.threadKey !== threadKey) {
    let watermarkMillis = 0;
    for (const { item } of rows) {
      if ("updatedAt" in item) {
        watermarkMillis = Math.max(watermarkMillis, DateTime.toEpochMillis(item.updatedAt));
      }
    }
    return {
      watch: { threadKey, seen: new Set(calls.map((call) => call.id)), watermarkMillis },
      fresh: false,
    };
  }
  const fresh = calls.filter(
    (call) => !previous.seen.has(call.id) && call.updatedAtMillis > previous.watermarkMillis,
  );
  if (fresh.length === 0) return { watch: previous, fresh: false };
  return {
    watch: { ...previous, seen: new Set([...previous.seen, ...fresh.map((call) => call.id)]) },
    fresh: true,
  };
}

export function useOpenEditorOnModelsMissing(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectId: string | null;
  readonly rows: ReadonlyArray<ThreadStructureVisibleTurnItem>;
  readonly loading: boolean;
}) {
  const { threadRef, projectId, rows, loading } = input;
  const watch = useRef<ModelsMissingWatch | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the right panel store's Editor when a new tool result arrives in the thread
  useEffect(() => {
    if (threadRef === null || projectId === null || loading) return;
    const observed = observeModelsMissing(watch.current, scopedThreadKey(threadRef), rows);
    watch.current = observed.watch;
    if (!observed.fresh) return;
    useSpeechModelRequests.getState().request(threadRef.environmentId);
    useRightPanelStore.getState().openEditor(threadRef, projectId);
  }, [loading, projectId, rows, threadRef]);
}
