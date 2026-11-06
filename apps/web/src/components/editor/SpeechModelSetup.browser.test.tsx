// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  EngineJobId,
  EnvironmentId,
  type EngineJob,
  type TranscribeModelsStatus,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { TranscriptionJobs } from "../../editor/editStore";

const state = vi.hoisted(() => ({
  status: null as TranscribeModelsStatus | null,
  jobs: { transcribe: null, download: null } as TranscriptionJobs,
}));

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

import { SpeechModelSetup } from "./SpeechModelSetup";

const environmentId = EnvironmentId.make("env-1");

const status = (
  recommended: "default" | "light",
  ready = false,
  lightFound?: { copyBytes: number },
): TranscribeModelsStatus => ({
  profiles: {
    default: { sizeBytes: 3_744_329_895, downloadedBytes: 0, ready },
    light: {
      sizeBytes: 2_287_244_626,
      downloadedBytes: 0,
      ready: false,
      ...(lightFound ? { found: lightFound } : {}),
    },
  },
  recommended,
  consent: "unasked",
  loadedProfile: null,
});

const downloadJob = (progress: number): EngineJob => ({
  id: EngineJobId.make("job-1"),
  kind: "transcribe.models.download",
  progress,
  stage: "download",
  state: "running",
});

const press = (name: string) =>
  act(async () => {
    const found = [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === name,
    );
    expect(found, `button ${name}`).toBeDefined();
    found!.click();
  });

/** Each test starts from no status, no jobs and fresh command mocks. */
const reset = () => {
  store.set({ status: null, jobs: { transcribe: null, download: null } });
  commands.download.mockReset();
  commands.cancel.mockClear();
  commands.dismiss.mockClear();
};

const renderSetup = () =>
  render(<SpeechModelSetup environmentId={environmentId} />, { router: false });

describe("SpeechModelSetup", () => {
  it("offers Standard and Light with sizes, Standard recommended and pre-selected", async () => {
    reset();
    store.set({ status: status("default") });
    await using screen = await renderSetup();
    await expect.element(screen.getByText(/Not downloaded/)).toBeVisible();
    await expect.element(screen.getByText("Standard, 3.7 GB")).toBeVisible();
    await expect.element(screen.getByText("Light, 2.3 GB")).toBeVisible();
    await expect.element(screen.getByText(/8 GB of memory or less/)).toBeVisible();
    const standard = screen.getByRole("radio", { name: /Standard/ });
    await expect.element(standard).toBeChecked();
    await expect
      .element(screen.getByRole("radio", { name: /Standard.*Recommended/ }))
      .toBeVisible();
    // Nothing downloads until the user presses Download.
    expect(commands.download).not.toHaveBeenCalled();
    commands.download.mockResolvedValue({ _tag: "Success", value: { jobId: "job-1" } });
    await press("Download 3.7 GB");
    expect(commands.download).toHaveBeenCalledWith({
      environmentId,
      input: { model: "default" },
    });
  });

  it("recommends and pre-selects Light on an 8 GB Mac, and the user can switch", async () => {
    reset();
    store.set({ status: status("light") });
    await using screen = await renderSetup();
    await expect.element(screen.getByRole("radio", { name: /Light.*Recommended/ })).toBeChecked();
    await act(async () =>
      (screen.getByRole("radio", { name: /Standard/ }).element() as HTMLElement).click(),
    );
    await expect.element(screen.getByRole("button", { name: "Download 3.7 GB" })).toBeVisible();
  });

  it("shows the download's progress and cancels it", async () => {
    reset();
    store.set({ status: status("default") });
    commands.download.mockImplementation(() => new Promise(() => {}));
    await using screen = await renderSetup();
    await press("Download 3.7 GB");
    await act(async () => store.set({ jobs: { transcribe: null, download: downloadJob(0.42) } }));
    const bar = screen.getByRole("progressbar", { name: "Speech model download" });
    await expect.element(bar).toHaveAttribute("aria-valuenow", "42");
    await expect.element(screen.getByText(/Downloading, 42%/)).toBeVisible();
    await press("Cancel download");
    expect(commands.cancel).toHaveBeenCalledWith({
      environmentId,
      input: { jobId: EngineJobId.make("job-1") },
    });
  });

  it("follows a download started elsewhere, and says Ready once a model is there", async () => {
    reset();
    store.set({
      status: status("default"),
      jobs: { transcribe: null, download: downloadJob(0.1) },
    });
    await using screen = await renderSetup();
    await expect.element(screen.getByText(/Downloading, 10%/)).toBeVisible();
    await act(async () =>
      store.set({ status: status("default", true), jobs: { transcribe: null, download: null } }),
    );
    await expect.element(screen.getByText(/^Ready\./)).toBeVisible();
    expect(document.querySelector('[role="radio"]')).toBeNull();
  });

  it("can be skipped: it never records an answer or starts anything by itself", async () => {
    reset();
    store.set({ status: status("default") });
    await using screen = await renderSetup();
    await expect.element(screen.getByText("Standard, 3.7 GB")).toBeVisible();
    expect(commands.download).not.toHaveBeenCalled();
    expect(commands.dismiss).not.toHaveBeenCalled();
  });

  it("offers a copy found on this Mac with Use, which reuses it only on the press", async () => {
    reset();
    store.set({ status: status("light", false, { copyBytes: 0 }) });
    await using screen = await renderSetup();
    await expect.element(screen.getByText("Found on this Mac, ready to use")).toBeVisible();
    await expect.element(screen.getByText(/takes no extra space/)).toBeVisible();
    expect(commands.download).not.toHaveBeenCalled();
    commands.download.mockResolvedValue({ _tag: "Success", value: {} });
    await press("Use");
    expect(commands.download).toHaveBeenCalledWith({
      environmentId,
      input: { model: "light", reuse: "clone" },
    });
  });

  it("says how much space a copy on another disk takes, and hides a copy that failed its check", async () => {
    reset();
    store.set({ status: status("light", false, { copyBytes: 2_287_244_626 }) });
    commands.download.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new Error(
          "The video engine rejected transcribe.models.download: the copy on this Mac does not match the pinned speech model; download it instead.",
        ),
      ),
    });
    await using screen = await renderSetup();
    await expect
      .element(screen.getByText(/on another disk, so using it copies 2\.3 GB/))
      .toBeVisible();
    await press("Use");
    expect(commands.download).toHaveBeenCalledWith({
      environmentId,
      input: { model: "light", reuse: "copy" },
    });
    await expect.element(screen.getByText(/the copy on this Mac does not match/)).toBeVisible();
    expect(document.body.textContent).not.toContain("Found on this Mac, ready to use");
    // The normal download is still offered.
    await expect.element(screen.getByRole("radio", { name: /Light/ })).toBeVisible();
  });

  it("shows nothing while the status is unknown", async () => {
    reset();
    await using _ = await renderSetup();
    expect(document.querySelector('section[aria-label="Speech model"]')).toBeNull();
  });
});
