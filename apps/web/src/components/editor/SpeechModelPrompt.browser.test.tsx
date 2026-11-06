// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import {
  EngineJobId,
  EnvironmentId,
  MODELS_MISSING_MESSAGE,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type TranscribeModelsStatus,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { TranscriptionJobs } from "../../editor/editStore";

const state = vi.hoisted(() => ({
  status: null as TranscribeModelsStatus | null,
  jobs: { transcribe: null, download: null } as TranscriptionJobs,
}));

/** The status query and jobs stream: setting either re-renders their readers. */
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: Partial<typeof state>) => {
      Object.assign(state, next);
      for (const listener of listeners) listener();
    },
  };
});

const commands = vi.hoisted(() => ({
  download: vi.fn(),
  dismiss: vi.fn(async () => ({ _tag: "Success", value: {} })),
  cancel: vi.fn(async () => ({ _tag: "Success", value: { applied: true } })),
}));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSpeechModelStatus: () => useSyncExternalStore(store.subscribe, () => state.status),
  useTranscriptionJobs: () => useSyncExternalStore(store.subscribe, () => state.jobs),
  refreshSpeechModelStatus: () => {},
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) => {
    if (command.label.endsWith("models-download")) return commands.download;
    if (command.label.endsWith("models-dismiss")) return commands.dismiss;
    return commands.cancel;
  }) as never,
}));

import "../../index.css";

import { useSpeechModelRequests } from "../../editor/editStore";
import { useOpenEditorOnModelsMissing } from "../../editor/modelsMissing";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { SpeechModelPrompt } from "./SpeechModelPrompt";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const projectRef = { environmentId, projectId };

const status = (
  overrides: Partial<TranscribeModelsStatus> = {},
  ready = false,
): TranscribeModelsStatus => ({
  profiles: {
    default: { sizeBytes: 3_744_329_895, downloadedBytes: 0, ready },
    light: { sizeBytes: 2_287_244_626, downloadedBytes: 0, ready: false },
  },
  recommended: "default",
  consent: "unasked",
  loadedProfile: null,
  ...overrides,
});

/** Base UI's dialog keeps animating in the test browser, so locator clicks never see it stable. */
const press = (name: string) =>
  act(async () => {
    const found = [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === name,
    );
    expect(found, `button ${name}`).toBeDefined();
    found!.click();
  });

const PROMPT = "The assistant needs the speech model to read your clip";
const promptShown = () => document.body.textContent?.includes(PROMPT) ?? false;

/** Each test starts from no status, no jobs and fresh command mocks. */
const reset = () => {
  store.set({ status: null, jobs: { transcribe: null, download: null } });
  useSpeechModelRequests.setState({ requested: {} });
  commands.download.mockReset();
  commands.dismiss.mockClear();
};

describe("SpeechModelPrompt", () => {
  it("asks at the top of the panel while the model is missing, and hides once it is downloaded", async () => {
    reset();
    store.set({ status: status({ recommended: "light" }) });
    let finish: (value: unknown) => void = () => {};
    commands.download.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await using screen = await render(<SpeechModelPrompt projectRef={projectRef} />, {
      router: false,
    });
    await expect.element(screen.getByText(PROMPT)).toBeVisible();
    const button = screen.getByRole("button", { name: "Download speech model" });
    await expect.element(button).toBeVisible();
    // Keyboard reachable: the prompt's button takes focus with Tab.
    await act(async () => (button.element() as HTMLElement).focus());
    expect(document.activeElement).toBe(button.element());

    // Pressing it only opens the question; nothing downloads before the user says yes.
    await press("Download speech model");
    expect(commands.download).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("radio", { name: /Light/ })).toBeChecked();
    await press("Download 2.3 GB");
    expect(commands.download).toHaveBeenCalledWith({
      environmentId,
      input: { model: "light", projectId },
    });
    await act(async () => {
      finish({ _tag: "Success", value: { jobId: EngineJobId.make("job-1") } });
      store.set({ status: status({ consent: "accepted" }, true) });
    });
    expect(promptShown()).toBe(false);
  });

  it("records Not now and stays away until the assistant asks again", async () => {
    reset();
    store.set({ status: status() });
    await using screen = await render(<SpeechModelPrompt projectRef={projectRef} />, {
      router: false,
    });
    await press("Download speech model");
    await press("Not now");
    expect(commands.dismiss).toHaveBeenCalledWith({ environmentId, input: {} });
    await act(async () => store.set({ status: status({ consent: "dismissed" }) }));
    expect(promptShown()).toBe(false);

    await act(async () => useSpeechModelRequests.getState().request(environmentId));
    await expect.element(screen.getByText(PROMPT)).toBeVisible();
  });

  it("shows a download already running instead of asking", async () => {
    reset();
    store.set({
      status: status({ consent: "accepted" }),
      jobs: {
        transcribe: null,
        download: {
          id: EngineJobId.make("job-2"),
          kind: "transcribe.models.download",
          progress: 0.25,
          stage: "download",
          state: "running",
        },
      },
    });
    await using screen = await render(<SpeechModelPrompt projectRef={projectRef} />, {
      router: false,
    });
    await expect.element(screen.getByText("Downloading the speech model…")).toBeVisible();
    await expect.element(screen.getByText(/25% downloaded/)).toBeVisible();
    expect(document.body.textContent).not.toContain("Download speech model");
  });
});

describe("useOpenEditorOnModelsMissing", () => {
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
  const at = (second: number) =>
    DateTime.makeUnsafe(new Date(Date.UTC(2026, 10, 6, 0, 0, second)).toISOString());
  const row = (id: string, second: number, output: unknown): ThreadStructureVisibleTurnItem => ({
    position: second,
    visibility: "local",
    sourceThreadId: threadRef.threadId,
    sourceItemId: TurnItemId.make(id),
    item: {
      id: TurnItemId.make(id),
      threadId: threadRef.threadId,
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
      toolName: "mcp__s7video__video_transcribe",
      input: {},
      output,
    },
  });

  function Thread(props: { readonly rows: ReadonlyArray<ThreadStructureVisibleTurnItem> }) {
    useOpenEditorOnModelsMissing({ threadRef, projectId, rows: props.rows, loading: false });
    return null;
  }

  it("opens the Editor panel for the thread's project when a video tool reports the missing model", async () => {
    reset();
    const first = [row("ok", 1, "Transcribing")];
    await using screen = await render(<Thread rows={first} />, { router: false });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toBe(null);
    await screen.rerender(
      <Thread
        rows={[...first, row("missing", 2, { content: [{ text: MODELS_MISSING_MESSAGE }] })]}
      />,
    );
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "editor", projectId });
    // The prompt shows again even after an earlier "Not now".
    expect(useSpeechModelRequests.getState().requested[environmentId]).toBe(true);
  });
});
