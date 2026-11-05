// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { EnvironmentId, MediaLibraryError, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

const commands = vi.hoisted(() => ({
  plan: vi.fn(),
  importMedia: vi.fn(),
  // An edit that already has media, unless a test says otherwise.
  readEdit: vi.fn(async () => ({ _tag: "Success", value: { document: { media: [{}] } } })),
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) =>
    command.label.endsWith("import-plan")
      ? commands.plan
      : command.label.endsWith("edit:get")
        ? commands.readEdit
        : commands.importMedia) as never,
}));

import { droppedMediaKind, useChatMediaImport } from "./useChatMediaImport";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const MIB = 1024 * 1024;

const video = new File([new Uint8Array(8)], "interview.mov", { type: "video/quicktime" });
const sound = new File([new Uint8Array(8)], "whoosh.m4a", { type: "audio/mp4" });
const notes = new File(["hi"], "notes.txt", { type: "text/plain" });

function Probe(props: {
  readonly projectId: ProjectId | null;
  readonly files: ReadonlyArray<File>;
  readonly onResult: (files: File[]) => void;
  readonly onFirstMedia?: ((projectId: ProjectId) => void) | undefined;
}) {
  const route = useChatMediaImport(environmentId, props.projectId, props.onFirstMedia);
  return (
    <button type="button" onClick={() => void route(props.files).then(props.onResult)}>
      route
    </button>
  );
}

/** The files the composer would still attach after the drop. */
async function dropped(
  projectId: ProjectId | null,
  files: ReadonlyArray<File>,
  onFirstMedia?: (projectId: ProjectId) => void,
) {
  let resolve: (files: File[]) => void = () => undefined;
  const promise = new Promise<File[]>((settle) => {
    resolve = settle;
  });
  await using screen = await render(
    <Probe projectId={projectId} files={files} onResult={resolve} onFirstMedia={onFirstMedia} />,
    { router: false },
  );
  await act(() => (screen.getByRole("button").element() as HTMLButtonElement).click());
  return await promise;
}

const failure = (error: unknown) => ({ _tag: "Failure", cause: Cause.fail(error) });

const editWithMedia = (count: number) => ({
  _tag: "Success",
  value: { revision: 1, document: { media: Array.from({ length: count }, () => ({})) } },
});

describe("useChatMediaImport", () => {
  it("classifies drops by type, then by extension", () => {
    expect(droppedMediaKind(video)).toBe("video");
    expect(droppedMediaKind({ name: "take.MP4", type: "" })).toBe("video");
    expect(droppedMediaKind({ name: "bed.wav", type: "" })).toBe("audio");
    expect(droppedMediaKind(notes)).toBe("other");
  });

  it("should import audio dropped in chat, and video without uploading it", async () => {
    using _bridge = stubGlobal("desktopBridge", {
      getPathForFile: (file: File) => `/Users/me/Desktop/${file.name}`,
    });
    commands.plan.mockResolvedValue({
      _tag: "Success",
      value: { suggestedMode: "copy", totalBytes: 60 * MIB, freeBytes: 900e9 },
    });
    commands.importMedia.mockResolvedValue({ _tag: "Success", value: { mediaId: "x" } });
    const attach = await dropped(projectId, [video, sound, notes]);
    // The video went to Assets only; the sound is attached as well, for the agent to hear.
    expect(attach).toEqual([sound, notes]);
    expect(commands.importMedia.mock.calls.map(([call]) => call.input)).toEqual([
      { projectId, sourcePath: "/Users/me/Desktop/interview.mov", mode: "copy" },
      { projectId, sourcePath: "/Users/me/Desktop/whoosh.m4a", mode: "copy" },
    ]);
  });

  it("opens the Editor when a drop brings the project's first media, and only then", async () => {
    using _bridge = stubGlobal("desktopBridge", {
      getPathForFile: (file: File) => `/Users/me/Desktop/${file.name}`,
    });
    commands.plan.mockResolvedValue({
      _tag: "Success",
      value: { suggestedMode: "copy", totalBytes: 60 * MIB, freeBytes: 900e9 },
    });
    commands.importMedia.mockResolvedValue({ _tag: "Success", value: { mediaId: "x" } });
    const opened = vi.fn();
    commands.readEdit.mockResolvedValueOnce(editWithMedia(0));
    await dropped(projectId, [video], opened);
    expect(opened.mock.calls).toEqual([[projectId]]);
    commands.readEdit.mockResolvedValueOnce(editWithMedia(1));
    await dropped(projectId, [video], opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("attaches as before outside a video project or without file paths", async () => {
    commands.importMedia.mockClear();
    using _bridge = stubGlobal("desktopBridge", {
      getPathForFile: (file: File) => `/Users/me/Desktop/${file.name}`,
    });
    commands.plan.mockResolvedValue(
      failure(new MediaLibraryError({ reason: "not-an-edit-project", explanation: "No edit." })),
    );
    expect(await dropped(projectId, [video, sound])).toEqual([video, sound]);
    expect(commands.importMedia).not.toHaveBeenCalled();
  });

  it("attaches everything in a browser, where dropped files have no path", async () => {
    commands.plan.mockClear();
    using _bridge = stubGlobal("desktopBridge", undefined);
    expect(await dropped(projectId, [video])).toEqual([video]);
    expect(commands.plan).not.toHaveBeenCalled();
  });
});
