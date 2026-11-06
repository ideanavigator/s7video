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
