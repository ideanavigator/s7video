// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
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

describe("rightPanelStore opens the Editor by default in a video project (S7V-076)", () => {
  const reload = async () => {
    const { storage, name } = useRightPanelStore.persist.getOptions();
    const persisted = await storage!.getItem(name!);
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    await storage!.setItem(name!, persisted!);
    await useRightPanelStore.persist.rehydrate();
  };

  it("opens the Editor by default in a video project", () => {
    useRightPanelStore.getState().openEditorByDefault(refA, "project-1");
    const { byThreadKey } = useRightPanelStore.getState();
    expect(selectActiveRightPanelSurface(byThreadKey, refA)).toEqual({
      id: "editor",
      kind: "editor",
      projectId: "project-1",
    });
    // Not a user choice, so a proactive panel's revision check still holds.
    expect(useRightPanelStore.getState().getUserActionRevision(refA)).toBe(0);
  });

  it("keeps the user's panel choice: a closed Editor stays closed after a reload", async () => {
    const store = useRightPanelStore.getState();
    store.openEditorByDefault(refA, "project-1");
    store.closeSurface(refA, "editor");
    await reload();
    useRightPanelStore.getState().openEditorByDefault(refA, "project-1");
    const { byThreadKey } = useRightPanelStore.getState();
    expect(selectActiveRightPanelSurface(byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(byThreadKey, refA).surfaces).toEqual([]);
  });

  it("keeps another tab the user picked, and a hidden panel", async () => {
    const store = useRightPanelStore.getState();
    store.openEditorByDefault(refA, "project-1");
    store.openFile(refA, "README.md");
    await reload();
    useRightPanelStore.getState().openEditorByDefault(refA, "project-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "file:README.md",
    );

    useRightPanelStore.getState().openEditorByDefault(refB, "project-1");
    useRightPanelStore.getState().close(refB);
    await reload();
    useRightPanelStore.getState().openEditorByDefault(refB, "project-1");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).isOpen,
    ).toBe(false);
  });

  it("leaves a thread the user arranged before alone", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    store.openEditorByDefault(refA, "project-1");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["diff"]);
  });

  it("proactive panels do not hide the Editor in a video project", () => {
    const store = useRightPanelStore.getState();
    store.openEditorByDefault(refA, "project-1");
    const revision = store.getUserActionRevision(refA);
    const diff = { kind: "diff", turnId: RunId.make("run-1") } as const;
    expect(store.openProactive(refA, diff, revision, false, true)).toBe(false);
    expect(
      store.openProactive(
        refA,
        { id: "pull-requests", kind: "pull-requests" },
        revision,
        false,
        true,
      ),
    ).toBe(false);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("editor");
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["editor"]);
    // The refused diff offer is recorded, so a revisit does not retry that turn.
    expect(state.proactiveDiffTurnId).toBe("run-1");
  });

  it("proactive panels behave as in T3 in a normal project, even over an Editor tab", () => {
    const store = useRightPanelStore.getState();
    store.openEditor(refA, "project-1");
    const revision = store.getUserActionRevision(refA);
    const diff = { kind: "diff", turnId: RunId.make("run-1") } as const;
    expect(store.openProactive(refA, diff, revision)).toBe(true);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "diff",
    );
  });

  it("proactive panels still open when another tab is active", () => {
    const store = useRightPanelStore.getState();
    store.openEditorByDefault(refA, "project-1");
    store.openFile(refA, "README.md");
    const revision = store.getUserActionRevision(refA);
    const diff = { kind: "diff", turnId: RunId.make("run-1") } as const;
    expect(store.openProactive(refA, diff, revision, false, true)).toBe(true);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("diff");
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "editor",
      "file:README.md",
      "diff",
    ]);
  });
});
