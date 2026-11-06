// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { EnvironmentId, type TranscribeModelsStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { SpeechModelStatusState } from "../../editor/editStore";

const state = vi.hoisted(() => ({ value: { _tag: "loading" } as SpeechModelStatusState }));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSpeechModelStatusState: () => state.value,
  useSpeechModelStatus: () => (state.value._tag === "ready" ? state.value.status : null),
  useTranscriptionJobs: () => ({ transcribe: null, download: null }),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => vi.fn()) as never,
}));

import "../../index.css";

import { SpeechModelSettings } from "./SpeechModelSettings";

const environmentId = EnvironmentId.make("env-1");

const missing: TranscribeModelsStatus = {
  profiles: {
    default: { sizeBytes: 3_744_329_895, downloadedBytes: 0, ready: false },
    light: { sizeBytes: 2_287_244_626, downloadedBytes: 0, ready: false },
  },
  recommended: "default",
  consent: "unasked",
  loadedProfile: null,
};

const visibleLabels = () =>
  [...document.querySelectorAll("h2, span")].filter(
    (element) =>
      element.textContent?.trim() === "Speech model" && !element.classList.contains("sr-only"),
  ).length;

describe("SpeechModelSettings", () => {
  it("shows no section, not even a heading, while the status loads", async () => {
    state.value = { _tag: "loading" };
    await using _ = await render(<SpeechModelSettings environmentId={environmentId} />, {
      router: false,
    });
    expect(document.body.textContent).not.toContain("Speech model");
  });

  it("says plainly when the engine can't answer", async () => {
    state.value = { _tag: "unavailable" };
    await using screen = await render(<SpeechModelSettings environmentId={environmentId} />, {
      router: false,
    });
    await expect.element(screen.getByText(/Speech model status unavailable/)).toBeVisible();
  });

  it("shows the speech model item once known, with one visible label", async () => {
    state.value = { _tag: "ready", status: missing };
    await using screen = await render(<SpeechModelSettings environmentId={environmentId} />, {
      router: false,
    });
    await expect.element(screen.getByText("Standard, 3.7 GB")).toBeVisible();
    expect(visibleLabels()).toBe(1);
  });
});
