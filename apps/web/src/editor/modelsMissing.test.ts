// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { MODELS_MISSING_MESSAGE, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { observeModelsMissing } from "./modelsMissing";

const threadId = ThreadId.make("thread-1");
const at = (second: number) =>
  DateTime.makeUnsafe(new Date(Date.UTC(2026, 10, 6, 0, 0, second)).toISOString());

const tool = (
  id: string,
  second: number,
  toolName: string,
  output: unknown,
): ThreadStructureVisibleTurnItem => ({
  position: second,
  visibility: "local",
  sourceThreadId: threadId,
  sourceItemId: TurnItemId.make(id),
  item: {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "failed",
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
    type: "dynamic_tool",
    toolName,
    input: {},
    output,
  },
});

// Claude reports an MCP error as content blocks; other providers as plain text.
const missing = (id: string, second: number, toolName = "mcp__s7video__video_transcribe") =>
  tool(id, second, toolName, { content: [{ type: "text", text: MODELS_MISSING_MESSAGE }] });

describe("observeModelsMissing", () => {
  it("only watches on the first read, so opening an old thread opens nothing", () => {
    const first = observeModelsMissing(null, "t1", [missing("old", 1)]);
    expect(first.fresh).toBe(false);
    expect(observeModelsMissing(first.watch, "t1", [missing("old", 1)]).fresh).toBe(false);
  });

  it("reports a video tool that answers models_missing after the watch began, once", () => {
    const first = observeModelsMissing(null, "t1", [tool("a", 1, "read_file", "ok")]);
    const rows = [tool("a", 1, "read_file", "ok"), missing("new", 2)];
    const next = observeModelsMissing(first.watch, "t1", rows);
    expect(next.fresh).toBe(true);
    expect(observeModelsMissing(next.watch, "t1", rows).fresh).toBe(false);
    // Plain text output, from a provider that does not wrap it, counts the same.
    const text = observeModelsMissing(next.watch, "t1", [
      ...rows,
      tool("text", 3, "video_remove_silences", MODELS_MISSING_MESSAGE),
    ]);
    expect(text.fresh).toBe(true);
  });

  it("ignores older history loaded later, other tools and other errors", () => {
    const first = observeModelsMissing(null, "t1", [tool("a", 10, "read_file", "ok")]);
    expect(observeModelsMissing(first.watch, "t1", [missing("history", 5)]).fresh).toBe(false);
    expect(
      observeModelsMissing(first.watch, "t1", [missing("other", 11, "mcp__x__read_file")]).fresh,
    ).toBe(false);
    expect(
      observeModelsMissing(first.watch, "t1", [tool("e", 12, "video_transcribe", "no clip")]).fresh,
    ).toBe(false);
  });

  it("starts a new watch when the thread changes", () => {
    const first = observeModelsMissing(null, "t1", []);
    expect(observeModelsMissing(first.watch, "t2", [missing("x", 1)]).fresh).toBe(false);
  });
});
