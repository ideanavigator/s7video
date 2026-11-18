// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ENGINE_SYSTEM_PATH,
  engineCommand,
  engineCommandArgs,
  engineEnvironment,
  huggingFaceCacheDirs,
  resolveEngineTools,
} from "./enginePaths.ts";

const makeTools = Effect.fn("test.makeTools")(function* (
  directory: string,
  names: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  for (const name of names) {
    const file = path.join(directory, name);
    yield* fileSystem.writeFileString(file, "#!/bin/sh\n");
    yield* fileSystem.chmod(file, 0o755);
  }
});

describe("enginePaths", () => {
  it.effect("resolves absolute uv and ffmpeg from settings, then env, then known dirs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-paths-" });
      const [settings, env, known, home] = ["settings", "env", "known", "home"].map((name) =>
        path.join(root, name),
      );
      yield* makeTools(settings!, ["uv"]);
      yield* makeTools(env!, ["uv", "ffmpeg"]);
      yield* makeTools(known!, ["uv", "ffmpeg", "ffprobe"]);
      // Not executable: skipped.
      yield* fileSystem.writeFileString(path.join(env!, "ffprobe"), "");

      const tools = yield* resolveEngineTools({
        configured: { uv: path.join(settings!, "uv") },
        env: {
          S7VIDEO_UV: path.join(env!, "uv"),
          S7VIDEO_FFMPEG: path.join(env!, "ffmpeg"),
          S7VIDEO_FFPROBE: path.join(env!, "ffprobe"),
          PATH: known!,
        },
        homeDir: home!,
        knownDirs: [known!],
      });
      expect(tools).toEqual({
        uv: path.join(settings!, "uv"),
        ffmpeg: path.join(env!, "ffmpeg"),
        ffprobe: path.join(known!, "ffprobe"),
      });

      const fromKnown = yield* resolveEngineTools({
        env: { S7VIDEO_UV: "uv" },
        homeDir: home!,
        knownDirs: [known!],
      });
      expect(fromKnown.uv).toBe(path.join(known!, "uv"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("should report missing_tool for absent ffmpeg", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-paths-" });
      yield* makeTools(root, ["uv"]);
      const outcome = yield* resolveEngineTools({
        env: { PATH: "/usr/bin:/bin" },
        homeDir: path.join(root, "home"),
        knownDirs: [root],
      }).pipe(Effect.exit);
      assert(Exit.isFailure(outcome));
      const error = outcome.cause.reasons[0];
      assert(error?._tag === "Fail");
      expect(error.error).toMatchObject({ reason: "missing_tool", tool: "ffmpeg" });
      expect(error.error.message).toBe(
        "The video engine needs ffmpeg, which was not found on this Mac. For development, install it with `brew install ffmpeg`, or set S7VIDEO_FFMPEG to its full path.",
      );

      const noUv = yield* resolveEngineTools({
        env: {},
        homeDir: path.join(root, "home"),
        knownDirs: [],
      }).pipe(Effect.flip);
      expect(noUv.message).toContain("needs uv");
      expect(noUv.message).toContain("brew install uv");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("engineCommand uses the bundled Python and never resolves uv (S7V-112)", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-paths-" });
      const bundle = path.join(root, "Resources");
      yield* makeTools(path.join(bundle, "python/bin"), ["python3.12"]);
      yield* makeTools(path.join(bundle, "ffmpeg/bin"), ["ffmpeg", "ffprobe"]);
      const python = path.join(bundle, "python/bin/python3.12");

      // No uv anywhere: a set S7VIDEO_PYTHON does not need one.
      const tools = yield* resolveEngineTools({
        env: { S7VIDEO_PYTHON: python, S7VIDEO_FFMPEG: path.join(bundle, "ffmpeg/bin/ffmpeg") },
        homeDir: path.join(root, "home"),
        knownDirs: [],
      });
      expect(tools).toEqual({
        python,
        ffmpeg: path.join(bundle, "ffmpeg/bin/ffmpeg"),
        ffprobe: path.join(bundle, "ffmpeg/bin/ffprobe"),
      });
      expect(engineCommand(tools, path.join(bundle, "engine"))).toEqual({
        command: python,
        args: ["-I", "-B", "-m", "s7engine"],
      });
      // Dev keeps `uv run` unchanged.
      expect(
        engineCommand({ uv: "/opt/uv", ffmpeg: "/f", ffprobe: "/p" }, "/repo/packages/engine"),
      ).toEqual({ command: "/opt/uv", args: engineCommandArgs("/repo/packages/engine") });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("packaged builds never look in Homebrew or other install folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-paths-" });
      const homebrew = path.join(root, "opt/homebrew/bin");
      yield* makeTools(homebrew, ["uv", "python", "ffmpeg", "ffprobe"]);
      const bundle = path.join(root, "Resources");
      yield* makeTools(path.join(bundle, "python/bin"), ["python3.12"]);
      yield* makeTools(path.join(bundle, "ffmpeg/bin"), ["ffmpeg", "ffprobe"]);
      const base = {
        S7VIDEO_PACKAGED: "1",
        S7VIDEO_PYTHON: path.join(bundle, "python/bin/python3.12"),
      };

      const tools = yield* resolveEngineTools({
        env: { ...base, S7VIDEO_FFMPEG: path.join(bundle, "ffmpeg/bin/ffmpeg") },
        homeDir: path.join(root, "home"),
        knownDirs: [homebrew],
      });
      expect(Object.values(tools).every((tool) => tool.startsWith(`${bundle}/`))).toBe(true);
      expect(tools.uv).toBeUndefined();

      // Homebrew's FFmpeg is there, but a packaged app does not take it.
      const noFfmpeg = yield* resolveEngineTools({
        env: base,
        homeDir: path.join(root, "home"),
        knownDirs: [homebrew],
      }).pipe(Effect.flip);
      expect(noFfmpeg).toMatchObject({ reason: "missing_tool", tool: "ffmpeg", packaged: true });
      expect(noFfmpeg.message).toBe(
        "The ffmpeg that comes with the app is missing. Reinstall the app to fix it.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a missing bundled Python gives the reinstall message", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "engine-paths-" });
      yield* makeTools(root, ["uv", "python3.12", "ffmpeg", "ffprobe"]);
      yield* fileSystem.remove(path.join(root, "python3.12"));
      const error = yield* resolveEngineTools({
        env: { S7VIDEO_PACKAGED: "1", S7VIDEO_PYTHON: path.join(root, "python3.12") },
        homeDir: path.join(root, "home"),
        knownDirs: [root],
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "missing_tool", tool: "python", packaged: true });
      expect(error.message).toBe(
        "The video engine that comes with the app is missing. Reinstall the app to fix it.",
      );

      // Outside the app, a wrong S7VIDEO_PYTHON is an error too, not a silent fall back to uv.
      const dev = yield* resolveEngineTools({
        env: { S7VIDEO_PYTHON: path.join(root, "python3.12") },
        homeDir: path.join(root, "home"),
        knownDirs: [root],
      }).pipe(Effect.flip);
      expect(dev).toMatchObject({ reason: "missing_tool", tool: "python" });
      expect(dev.message).toContain("S7VIDEO_PYTHON");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("names the Hugging Face caches to look in, never ~/.t3 or our own models folder", () => {
    const home = "/Users/someone";
    const models = "/Users/someone/.s7video/engine/models";
    expect(huggingFaceCacheDirs({}, home, models)).toEqual([
      "/Users/someone/.cache/huggingface/hub",
    ]);
    expect(
      huggingFaceCacheDirs(
        { HF_HUB_CACHE: "/Volumes/ssd/hf/hub/", HF_HOME: "/Users/someone/hf" },
        home,
        models,
      ),
    ).toEqual([
      "/Volumes/ssd/hf/hub",
      "/Users/someone/hf/hub",
      "/Users/someone/.cache/huggingface/hub",
    ]);
    expect(
      huggingFaceCacheDirs(
        { HF_HUB_CACHE: "/Users/someone/.t3/hub", HF_HOME: models },
        home,
        models,
      ),
    ).toEqual(["/Users/someone/.cache/huggingface/hub"]);
    expect(huggingFaceCacheDirs({ HF_HUB_CACHE: "relative/hub" }, home, models)).toEqual([
      "/Users/someone/.cache/huggingface/hub",
    ]);
    const env = engineEnvironment({
      tools: { uv: "/opt/uv", ffmpeg: "/opt/ffmpeg", ffprobe: "/opt/ffprobe" },
      homeDir: home,
      modelsDir: models,
      tmpDir: undefined,
      huggingFaceCacheDirs: huggingFaceCacheDirs({}, home, models),
    });
    expect(env.S7_HF_CACHE_DIRS).toBe('["/Users/someone/.cache/huggingface/hub"]');
  });

  it("should not inherit parent PATH or HOME paths under ~/.t3", () => {
    const env = engineEnvironment({
      tools: { uv: "/opt/uv", ffmpeg: "/opt/ffmpeg", ffprobe: "/opt/ffprobe" },
      homeDir: "/Users/someone",
      modelsDir: "/tmp/state/models",
      tmpDir: "/var/tmp/x",
    });
    expect(env).toEqual({
      PATH: ENGINE_SYSTEM_PATH,
      HOME: "/Users/someone",
      TMPDIR: "/var/tmp/x",
      LANG: "en_US.UTF-8",
      UV_NO_PROGRESS: "1",
      HF_HOME: "/tmp/state/models",
      HF_HUB_OFFLINE: "1",
      S7_FFMPEG: "/opt/ffmpeg",
      S7_FFPROBE: "/opt/ffprobe",
    });
    expect(Object.values(env).some((value) => value.includes("/.t3"))).toBe(false);
    expect(engineCommandArgs("/repo/packages/engine")).toEqual([
      "run",
      "--frozen",
      "--offline",
      "--quiet",
      "--project",
      "/repo/packages/engine",
      "python",
      "-I",
      // `-I` ignores PYTHONDONTWRITEBYTECODE; `-B` keeps `.pyc` out of watched `packages/` (S7V-071).
      "-B",
      "-m",
      "s7engine",
    ]);
  });
});
