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

const toasts = vi.hoisted(() => ({ add: vi.fn((_toast: unknown) => "toast-id"), close: vi.fn() }));
vi.mock(import("../ui/toast"), () => ({ toastManager: toasts as never }));

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

  describe("when a chat drop cannot be imported (S7V-071)", () => {
    interface ToastCall {
      readonly type: string;
      readonly title: string;
      readonly description?: string;
      readonly timeout?: number;
      readonly actionProps?: { readonly children: string; readonly onClick: () => void };
    }
    const shown = () => toasts.add.mock.calls.map(([toast]) => toast as ToastCall);
    const errors = () => shown().filter((toast) => toast.type === "error");
    const notAVideo = failure(
      new MediaLibraryError({ reason: "not-a-media-file", explanation: "Not a video." }),
    );

    function setUp() {
      toasts.add.mockClear();
      toasts.close.mockClear();
      commands.importMedia.mockReset();
      commands.readEdit.mockReset();
      commands.readEdit.mockResolvedValue(editWithMedia(1));
      commands.plan.mockResolvedValue({
        _tag: "Success",
        value: { suggestedMode: "reference", totalBytes: 60 * MIB, freeBytes: 900e9 },
      });
      return stubGlobal("desktopBridge", {
        getPathForFile: (file: File) => `/Users/me/Desktop/${file.name}`,
      });
    }

    it("shows why a dropped video could not be added, with Retry, and does not attach it", async () => {
      using _bridge = setUp();
      commands.importMedia.mockResolvedValue(notAVideo);
      expect(await dropped(projectId, [video, notes])).toEqual([notes]);
      expect(shown()).toEqual([
        expect.objectContaining({
          type: "error",
          title: "Couldn't add interview.mov to Assets",
          description: "Not a video.",
          timeout: 0,
          actionProps: expect.objectContaining({ children: "Retry" }),
        }),
      ]);
    });

    it("falls back to a plain reason when the failure carries none", async () => {
      using _bridge = setUp();
      commands.importMedia.mockResolvedValue(failure(new Error("socket closed")));
      await dropped(projectId, [video]);
      expect(errors().map((toast) => toast.description)).toEqual([
        "Check that the project's server is running, then try again.",
      ]);
    });

    it("Retry imports the file again and opens the Editor on success", async () => {
      using _bridge = setUp();
      commands.readEdit.mockResolvedValue(editWithMedia(0));
      commands.importMedia
        .mockResolvedValueOnce(notAVideo)
        .mockResolvedValueOnce({ _tag: "Success", value: { mediaId: "x" } });
      const opened = vi.fn();
      await dropped(projectId, [video], opened);
      expect(opened).not.toHaveBeenCalled();
      errors()[0]!.actionProps!.onClick();
      expect(toasts.close).toHaveBeenCalledWith("toast-id");
      await vi.waitFor(() => expect(opened.mock.calls).toEqual([[projectId]]));
      expect(commands.importMedia.mock.calls.map(([call]) => call.input)).toEqual([
        { projectId, sourcePath: "/Users/me/Desktop/interview.mov", mode: "reference" },
        { projectId, sourcePath: "/Users/me/Desktop/interview.mov", mode: "reference" },
      ]);
      expect(shown().at(-1)).toEqual({ type: "success", title: "Added to Assets" });
    });

    it("Retry that fails again shows the same message and nothing else", async () => {
      using _bridge = setUp();
      commands.importMedia.mockResolvedValue(notAVideo);
      const opened = vi.fn();
      await dropped(projectId, [video], opened);
      errors()[0]!.actionProps!.onClick();
      await vi.waitFor(() => expect(errors()).toHaveLength(2));
      expect(errors()[1]!.title).toBe("Couldn't add interview.mov to Assets");
      expect(shown().filter((toast) => toast.type === "success")).toEqual([]);
      expect(opened).not.toHaveBeenCalled();
    });

    it("a failed audio drop is still attached and says why", async () => {
      using _bridge = setUp();
      commands.importMedia.mockResolvedValue(notAVideo);
      expect(await dropped(projectId, [sound])).toEqual([sound]);
      expect(errors().map(({ title, description }) => ({ title, description }))).toEqual([
        {
          title: "Couldn't add whoosh.m4a to Assets",
          description: "Not a video. It's still attached to your message.",
        },
      ]);
    });

    it("two failed drops show one toast each, and each Retry retries only its own file", async () => {
      using _bridge = setUp();
      const take = new File([new Uint8Array(8)], "take-2.mp4", { type: "video/mp4" });
      commands.importMedia.mockResolvedValue(notAVideo);
      expect(await dropped(projectId, [video, take])).toEqual([]);
      expect(errors().map((toast) => toast.title)).toEqual([
        "Couldn't add interview.mov to Assets",
        "Couldn't add take-2.mp4 to Assets",
      ]);
      commands.importMedia.mockClear();
      commands.importMedia.mockResolvedValue({ _tag: "Success", value: { mediaId: "x" } });
      errors()[1]!.actionProps!.onClick();
      await vi.waitFor(() => expect(shown().at(-1)?.type).toBe("success"));
      expect(commands.importMedia.mock.calls.map(([call]) => call.input.sourcePath)).toEqual([
        "/Users/me/Desktop/take-2.mp4",
      ]);
    });
  });
});
