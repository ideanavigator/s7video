// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import {
  type EditDocument,
  EditUnavailableError,
  type EditVersion,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ProjectEditState, ProjectVersionsState } from "../../editor/editStore";

const state = vi.hoisted(() => ({
  versions: { _tag: "loading" } as ProjectVersionsState,
  edit: { _tag: "loading" } as ProjectEditState,
}));

const commands = vi.hoisted(() => ({
  get: vi.fn(),
  tag: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  other: vi.fn(),
}));

vi.mock(import("../../editor/editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjectVersions: () => state.versions,
  useProjectEdit: () => state.edit,
  refreshProjectVersions: () => undefined,
}));
const confirms = vi.hoisted(() => ({ request: vi.fn(async () => true) }));
vi.mock(import("../../confirmDialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  requestConfirmDialog: confirms.request,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string } | undefined) => {
    const label = command?.label ?? "";
    if (label.endsWith("version-get")) return commands.get;
    if (label.endsWith("version-tag")) return commands.tag;
    if (label.endsWith("version-restore")) return commands.restore;
    if (label.endsWith("version-delete")) return commands.remove;
    return commands.other;
  }) as never,
}));

import "../../index.css";

import { VersionsTab } from "./VersionsTab";

const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("env-1");

const document: EditDocument = {
  version: 1,
  fps: { num: 30, den: 1 },
  canvas: { width: 1920, height: 1080 },
  media: [],
  tracks: [],
  markers: [],
  metadata: {},
};

const version = (n: number, overrides: Partial<EditVersion> = {}): EditVersion => ({
  n,
  revision: n + 1,
  at: Date.UTC(2026, 10, 7, 9, n),
  author: "you",
  changes: [`Change ${n}`],
  current: false,
  ...overrides,
});

const LIST: ReadonlyArray<EditVersion> = [
  version(3, {
    current: true,
    author: "assistant",
    threadId: ThreadId.make("thread-b"),
    runId: RunId.make("run-b"),
    changes: ["Removed 14.2 s of silence in 26 cuts", "Added captions"],
  }),
  version(2, { tag: "first cut" }),
  version(1),
];

const setReady = (versions: ReadonlyArray<EditVersion>) => {
  state.versions = { _tag: "ready", versions };
  state.edit = {
    _tag: "ready",
    snapshot: { revision: 4, canUndo: true, canRedo: false, document, version: 3 },
  };
};

const renderTab = (handlers: { onPreview?: () => void; onShowCurrent?: () => void } = {}) => {
  const container = window.document.createElement("div");
  container.style.height = "600px";
  container.style.width = "420px";
  return render(
    <VersionsTab
      projectRef={{ environmentId, projectId }}
      previewing={null}
      onPreview={handlers.onPreview ?? vi.fn()}
      onShowCurrent={handlers.onShowCurrent ?? vi.fn()}
    />,
    { container },
  );
};

const failure = (error: unknown) => ({ _tag: "Failure", cause: Cause.fail(error) });

describe("VersionsTab", () => {
  it("should list versions newest first, mark the newest Main and link its chat", async () => {
    setReady(LIST);
    await using screen = await renderTab();
    const rows = screen.getByRole("listitem").all();
    expect(rows.map((row) => row.element().getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
    await expect.element(rows[0]!).toHaveAccessibleName(/^Version 3, by the assistant, .+, main$/u);
    await expect.element(rows[0]!.getByText("Main", { exact: true })).toBeVisible();
    await expect.element(rows[1]!).toHaveAccessibleName(/^Version 2, first cut, by you, /u);
    await expect
      .element(screen.getByText("Removed 14.2 s of silence in 26 cuts; Added captions"))
      .toBeVisible();
    // Main has no Preview, Make main or Delete: it is what the player shows.
    expect(rows[0]!.getByRole("button", { name: "Make version 3 main" }).query()).toBeNull();
    expect(rows[0]!.getByRole("button", { name: "Preview" }).query()).toBeNull();
    expect(rows[0]!.getByRole("button", { name: "Delete" }).query()).toBeNull();
    expect(screen.getByText("Current", { exact: true }).query()).toBeNull();
    // Every other version offers Make main, Preview, Name… and Delete, and nothing else to revert.
    for (const [index, n] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const row = rows[index]!;
      await expect
        .element(row.getByRole("button", { name: `Make version ${n} main` }))
        .toHaveTextContent("Make main");
      await expect.element(row.getByRole("button", { name: "Preview" })).toBeVisible();
      await expect.element(row.getByRole("button", { name: /^(Name|Rename)…$/u })).toBeVisible();
      await expect.element(row.getByRole("button", { name: "Delete" })).toBeVisible();
      expect(row.getByRole("button", { name: /revert|current/iu }).query()).toBeNull();
    }
    await expect
      .element(rows[0]!.getByRole("link", { name: "Open chat" }))
      .toHaveAttribute("href", "/env-1/thread-b");
    expect(rows[1]!.getByRole("link", { name: "Open chat" }).query()).toBeNull();
  });

  it("should show the empty state before the first version", async () => {
    setReady([]);
    await using screen = await renderTab();
    await expect.element(screen.getByText("No versions yet")).toBeVisible();
    await expect
      .element(screen.getByText("Ask the assistant for a change, or drop a video here."))
      .toBeVisible();
  });

  it("should preview a version by reading it, without changing the edit", async () => {
    setReady(LIST);
    commands.get.mockResolvedValueOnce({ _tag: "Success", value: { version: LIST[1], document } });
    const onPreview = vi.fn();
    await using screen = await renderTab({ onPreview });
    await screen.getByRole("listitem").nth(1).getByRole("button", { name: "Preview" }).click();
    await vi.waitFor(() => expect(onPreview).toHaveBeenCalledWith(2, document));
    expect(commands.get).toHaveBeenCalledWith({ environmentId, input: { projectId, n: 2 } });
    expect(commands.restore).not.toHaveBeenCalled();
    expect(commands.tag).not.toHaveBeenCalled();
    expect(commands.other).not.toHaveBeenCalled();
  });

  it("should make a version main on the shown revision and go back to the current edit", async () => {
    setReady(LIST);
    commands.restore.mockResolvedValueOnce({ _tag: "Success", value: {} });
    const onShowCurrent = vi.fn();
    await using screen = await renderTab({ onShowCurrent });
    await screen
      .getByRole("listitem")
      .nth(2)
      .getByRole("button", { name: "Make version 1 main" })
      .click();
    await vi.waitFor(() => expect(onShowCurrent).toHaveBeenCalled());
    expect(commands.restore).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, n: 1, baseRevision: 4 },
    });
  });

  it("should delete a version after confirming, leaving Main alone", async () => {
    setReady(LIST);
    commands.remove.mockResolvedValueOnce({ _tag: "Success", value: {} });
    await using screen = await renderTab();
    await screen.getByRole("listitem").nth(1).getByRole("button", { name: "Delete" }).click();
    await vi.waitFor(() =>
      expect(commands.remove).toHaveBeenCalledWith({ environmentId, input: { projectId, n: 2 } }),
    );
    expect(confirms.request).toHaveBeenCalledWith(
      'Delete v2 "first cut"? Your clips in Media are not touched.',
      { variant: "destructive" },
    );
    expect(commands.restore).not.toHaveBeenCalled();
  });

  it("should name a version, and say so plainly when the name is taken", async () => {
    setReady(LIST);
    commands.tag.mockResolvedValueOnce(
      failure(
        new EditUnavailableError({
          projectId,
          reason: "tag-taken",
          explanation: "v2 already has that name. Pick another name.",
        }),
      ),
    );
    commands.tag.mockResolvedValueOnce({ _tag: "Success", value: LIST[2] });
    await using screen = await renderTab();
    await screen.getByRole("listitem").nth(2).getByRole("button", { name: "Name…" }).click();
    const input = page.getByLabelText("Version name");
    await expect.element(input).toHaveFocus();
    await userEvent.fill(input, "first cut");
    // Enter submits the name (the dialog's buttons sit below this small test viewport).
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("v2 already has that name. Pick another name.");
    await userEvent.fill(input, "  rough  ");
    // Enter submits the name (the dialog's buttons sit below this small test viewport).
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(page.getByLabelText("Version name").query()).toBeNull());
    expect(commands.tag).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId, n: 1, tag: "rough" },
    });
  });

  it("should clear a name when it is saved empty", async () => {
    setReady(LIST);
    commands.tag.mockResolvedValueOnce({ _tag: "Success", value: version(2) });
    await using screen = await renderTab();
    await screen.getByRole("listitem").nth(1).getByRole("button", { name: "Rename…" }).click();
    await userEvent.clear(page.getByLabelText("Version name"));
    // Enter submits the name (the dialog's buttons sit below this small test viewport).
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(commands.tag).toHaveBeenLastCalledWith({
        environmentId,
        input: { projectId, n: 2, tag: null },
      }),
    );
  });
});
