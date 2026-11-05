// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// Absolute paths and the explicit environment for the video engine. Electron starts the server
// with a minimal PATH (spike A1), so nothing here searches PATH: each tool comes from a configured
// path, then its S7VIDEO_* variable, then the usual install folders.
import { EngineError, type EngineTool } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const TOOL_ENV_VARS: Record<EngineTool, string> = {
  uv: "S7VIDEO_UV",
  ffmpeg: "S7VIDEO_FFMPEG",
  ffprobe: "S7VIDEO_FFPROBE",
};

const ENGINE_DIR_ENV_VAR = "S7VIDEO_ENGINE_DIR";

/** The engine's PATH: system folders only, never the parent's PATH. */
export const ENGINE_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface EngineTools {
  readonly uv: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface EngineToolSources {
  /** Paths chosen in settings; they win over everything else. */
  readonly configured?: Partial<Record<EngineTool, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /** Defaults to Homebrew's, /usr/local/bin and ~/.local/bin. */
  readonly knownDirs?: ReadonlyArray<string>;
}

const isExecutableFile = Effect.fnUntraced(function* (candidate: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
  return info._tag === "Some" && info.value.type === "File" && (info.value.mode & 0o111) !== 0;
});

const firstExecutable = Effect.fnUntraced(function* (
  candidates: ReadonlyArray<string | undefined>,
) {
  const path = yield* Path.Path;
  for (const candidate of candidates) {
    if (candidate && path.isAbsolute(candidate) && (yield* isExecutableFile(candidate))) {
      return candidate;
    }
  }
  return undefined;
});

/** uv, ffmpeg and ffprobe as absolute paths; a missing one fails with `missing_tool` naming it. */
export const resolveEngineTools = Effect.fn("enginePaths.resolveEngineTools")(function* (
  sources: EngineToolSources,
) {
  const path = yield* Path.Path;
  const knownDirs = sources.knownDirs ?? [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(sources.homeDir, ".local/bin"),
  ];
  const resolve = Effect.fnUntraced(function* (
    tool: EngineTool,
    extra: ReadonlyArray<string> = [],
  ) {
    const found = yield* firstExecutable([
      sources.configured?.[tool],
      sources.env[TOOL_ENV_VARS[tool]],
      ...extra,
      ...knownDirs.map((directory) => path.join(directory, tool)),
    ]);
    if (found === undefined) {
      return yield* new EngineError({ reason: "missing_tool", method: "start", tool });
    }
    return found;
  });
  const uv = yield* resolve("uv");
  const ffmpeg = yield* resolve("ffmpeg");
  // A configured FFmpeg brings its own ffprobe; prefer it over another install's.
  const ffprobe = yield* resolve("ffprobe", [path.join(path.dirname(ffmpeg), "ffprobe")]);
  return { uv, ffmpeg, ffprobe } satisfies EngineTools;
});

/** packages/engine, from the source tree or a bundled server; `S7VIDEO_ENGINE_DIR` overrides. */
export const resolveEngineProjectDir = Effect.fn("enginePaths.resolveEngineProjectDir")(function* (
  env: Readonly<Record<string, string | undefined>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = [
    env[ENGINE_DIR_ENV_VAR],
    path.resolve(import.meta.dirname, "../../../../packages/engine"),
    path.resolve(import.meta.dirname, "../../../packages/engine"),
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const hasProject = yield* fileSystem
      .exists(path.join(candidate, "pyproject.toml"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasProject) return candidate;
  }
  return yield* new EngineError({ reason: "start_failed", method: "start" });
});

export interface EngineEnvironmentInput {
  readonly tools: EngineTools;
  readonly homeDir: string;
  readonly modelsDir: string;
  readonly tmpDir: string | undefined;
  /** Registers the engine's crash, hang and slow-job hooks; tests only. */
  readonly testMethods?: boolean;
}

/** The engine's whole environment. Nothing else from the server's environment reaches it. */
export function engineEnvironment(input: EngineEnvironmentInput): Record<string, string> {
  return {
    PATH: ENGINE_SYSTEM_PATH,
    // uv finds its cache and managed Pythons under HOME.
    HOME: input.homeDir,
    ...(input.tmpDir ? { TMPDIR: input.tmpDir } : {}),
    LANG: "en_US.UTF-8",
    UV_NO_PROGRESS: "1",
    HF_HOME: input.modelsDir,
    HF_HUB_OFFLINE: "1",
    S7_FFMPEG: input.tools.ffmpeg,
    S7_FFPROBE: input.tools.ffprobe,
    ...(input.testMethods ? { S7_ENGINE_TEST_METHODS: "1" } : {}),
  };
}

export function engineCommandArgs(projectDir: string): ReadonlyArray<string> {
  // `-I` keeps the working directory and PYTHON* variables out of Python's import path.
  return [
    "run",
    "--frozen",
    "--offline",
    "--quiet",
    "--project",
    projectDir,
    "python",
    "-I",
    "-m",
    "s7engine",
  ];
}
