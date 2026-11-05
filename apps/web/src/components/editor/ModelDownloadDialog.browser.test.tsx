// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { TranscribeModelsStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ModelDownloadDialog, type ModelDownloadState } from "./ModelDownloadDialog";

const status = (recommended: "default" | "light"): TranscribeModelsStatus => ({
  profiles: {
    default: { sizeBytes: 3_744_329_895, downloadedBytes: 0, ready: false },
    light: { sizeBytes: 2_287_244_626, downloadedBytes: 0, ready: false },
  },
  recommended,
  consent: "unasked",
  loadedProfile: null,
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

const renderDialog = (recommended: "default" | "light", state: ModelDownloadState) => {
  const handlers = { onDownload: vi.fn(), onCancelDownload: vi.fn(), onDismiss: vi.fn() };
  return render(
    <ModelDownloadDialog open status={status(recommended)} state={state} {...handlers} />,
  ).then((screen) => ({ screen, handlers }));
};

describe("ModelDownloadDialog", () => {
  it("ModelDownloadDialog shows sizes and light option", async () => {
    const { screen, handlers } = await renderDialog("default", { phase: "asking" });
    await using _ = screen;
    await expect.element(screen.getByText("Standard, 3.7 GB")).toBeVisible();
    await expect.element(screen.getByText("Light, 2.3 GB")).toBeVisible();
    await expect
      .element(screen.getByText("Smaller and faster, a few more mistakes."))
      .toBeVisible();
    await expect.element(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
    await press("Download 3.7 GB");
    expect(handlers.onDownload).toHaveBeenCalledWith("default");
  });

  it("pre-selects the light model on an 8 GB Mac", async () => {
    const { screen, handlers } = await renderDialog("light", { phase: "asking" });
    await using _ = screen;
    await expect.element(screen.getByRole("radio", { name: /Light/ })).toBeChecked();
    await press("Download 2.3 GB");
    expect(handlers.onDownload).toHaveBeenCalledWith("light");
    await press("Not now");
    expect(handlers.onDismiss).toHaveBeenCalledOnce();
  });

  it("shows progress with a label and lets the download be cancelled", async () => {
    const { screen, handlers } = await renderDialog("default", {
      phase: "downloading",
      progress: 0.42,
    });
    await using _ = screen;
    const bar = screen.getByRole("progressbar", { name: "Speech model download" });
    await expect.element(bar).toHaveAttribute("aria-valuenow", "42");
    await press("Cancel download");
    expect(handlers.onCancelDownload).toHaveBeenCalledOnce();
  });

  it("shows a failed download's reason and offers to try again", async () => {
    const message =
      "The video engine rejected transcribe.models.download: there is not enough free disk space for the speech model.";
    const { screen, handlers } = await renderDialog("default", { phase: "failed", message });
    await using _ = screen;
    await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
    await press("Try again");
    expect(handlers.onDownload).toHaveBeenCalledWith("default");
  });
});
