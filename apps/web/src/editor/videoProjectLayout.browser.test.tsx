// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({ video: false, mediaRefs: [] as Array<unknown> }));

vi.mock(import("./editStore"), async (importOriginal) => ({
  ...(await importOriginal()),
  useIsVideoProject: () => state.video,
}));
vi.mock(import("../state/media"), () => ({
  useMediaLibrary: ((ref: unknown) => {
    state.mediaRefs.push(ref);
    return { _tag: "loading" };
  }) as never,
}));

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useVideoProjectLayout } from "./videoProjectLayout";

const environmentId = EnvironmentId.make("env-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));

function Thread() {
  const video = useVideoProjectLayout({ threadRef, projectRef });
  return <output>{video ? "video" : "other"}</output>;
}

const fresh = () => {
  state.mediaRefs = [];
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  return { [Symbol.dispose]: () => useRightPanelStore.setState({ byThreadKey: {} }) };
};

describe("useVideoProjectLayout (S7V-076)", () => {
  it("opens the Editor by default in a video project", async () => {
    using _store = fresh();
    state.video = true;
    // Only the panel store and React are involved; no navigation.
    await using screen = await render(<Thread />, { router: false });
    await expect.element(screen.getByRole("status")).toHaveTextContent("video");
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ id: "editor", kind: "editor", projectId: "project-1" });
    // Media stays subscribed, so a chat link to a clip finds it with the Editor closed.
    expect(state.mediaRefs.at(-1)).toEqual(projectRef);
  });

  it("does not open in a non-video project", async () => {
    using _store = fresh();
    state.video = false;
    await using screen = await render(<Thread />, { router: false });
    await expect.element(screen.getByRole("status")).toHaveTextContent("other");
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(state.mediaRefs.every((ref) => ref === null)).toBe(true);
  });
});
