// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";
import { reopenClosedView } from "./reopenClosedView";
import {
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

/** Panel state as storage version 14 saved it, before the Editor existed. */
const V14_FIXTURE = {
  byThreadKey: {
    "env-1:thread-A": {
      isOpen: true,
      activeSurfaceId: "file:src/app.ts",
      surfaces: [
        { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
        {
          id: "terminal:term-1",
          kind: "terminal",
          resourceId: "term-1",
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
        },
        { id: "diff", kind: "diff" },
        { id: "files", kind: "files" },
        {
          id: "file:src/app.ts",
          kind: "file",
          relativePath: "src/app.ts",
          revealLine: 3,
          revealRequestId: 1,
        },
        { id: "side-chat:thread-S", kind: "side-chat", threadId: "thread-S" },
      ],
    },
  },
  threadPanelVisibilityByThreadKey: {},
};

describe("rightPanelStore opens editor per project", () => {
  it("stores only the project on the thread's Editor surface", () => {
    useRightPanelStore.getState().openEditor(refA, "project-1");
    const { byThreadKey } = useRightPanelStore.getState();
    expect(selectActiveRightPanelSurface(byThreadKey, refA)).toEqual({
      id: "editor",
      kind: "editor",
      projectId: "project-1",
    });
  });

  it("gives two threads of one project their own surface on the same project", () => {
    const store = useRightPanelStore.getState();
    store.openEditor(refA, "project-1");
    store.openEditor(refB, "project-1");
    const { byThreadKey } = useRightPanelStore.getState();
    expect(selectActiveRightPanelSurface(byThreadKey, refA)).toEqual(
      selectActiveRightPanelSurface(byThreadKey, refB),
    );
  });

  it("keeps one Editor tab per thread and points it at the latest project", () => {
    const store = useRightPanelStore.getState();
    store.openEditor(refA, "project-1");
    store.openFile(refA, "README.md");
    store.openEditor(refA, "project-2");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.filter((surface) => surface.kind === "editor")).toEqual([
      { id: "editor", kind: "editor", projectId: "project-2" },
    ]);
    expect(state.activeSurfaceId).toBe("editor");
  });

  it("reopens a closed Editor on its project", async () => {
    const store = useRightPanelStore.getState();
    store.openEditor(refA, "project-1");
    store.closeSurface(refA, "editor");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([]);
    await reopenClosedView(useClosedViewStore.getState().entries[0]!, {
      workspaceAvailable: true,
      openPreview: () => {
        throw new Error("The Editor must not create a browser session");
      },
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ kind: "editor", projectId: "project-1" });
  });
});

describe("rightPanelStore migrates v14 to v15", () => {
  it("keeps every open surface from version 14", () => {
    const migrated = migratePersistedRightPanelState(V14_FIXTURE);
    const state = selectThreadRightPanelState(migrated.byThreadKey, refA);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("file:src/app.ts");
    expect(state.surfaces).toEqual(V14_FIXTURE.byThreadKey["env-1:thread-A"].surfaces);
  });

  it("keeps a saved Editor and drops one without a project", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "editor",
          surfaces: [{ id: "editor", kind: "editor", projectId: "project-1" }],
        },
        "env-1:thread-B": {
          isOpen: true,
          activeSurfaceId: "editor",
          surfaces: [
            { id: "diff", kind: "diff" },
            { id: "editor", kind: "editor" },
          ],
        },
      },
    });
    expect(selectActiveRightPanelSurface(migrated.byThreadKey, refA)).toEqual({
      id: "editor",
      kind: "editor",
      projectId: "project-1",
    });
    expect(selectThreadRightPanelState(migrated.byThreadKey, refB).surfaces).toEqual([
      { id: "diff", kind: "diff" },
    ]);
  });

  it("saves the Editor and restores it after a reload", async () => {
    useRightPanelStore.getState().openEditor(refA, "project-1");
    const { storage, name, version } = useRightPanelStore.persist.getOptions();
    expect(version).toBe(15);
    const persisted = await storage!.getItem(name!);
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    await storage!.setItem(name!, persisted!);
    await useRightPanelStore.persist.rehydrate();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ kind: "editor", projectId: "project-1" });
  });
});
