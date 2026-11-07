// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The skills the app ships (S7V-048). `apps/server/skills` is a Claude plugin folder; its `skills/`
// subfolder is also the root Codex loads through `skills/extraRoots/set`. Agents read these files
// themselves, so the folder must be a real directory: never one inside an asar archive.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isVideoProjectFolder } from "../edit/EditProjectLayout.ts";

/** Set by the desktop app to its packaged `Resources/skills`. */
const BUILT_IN_SKILLS_DIR_ENV_VAR = "S7VIDEO_SKILLS_DIR";

/** The built-in skills folder (a Claude plugin), from the env, the source tree or a bundled server. */
export const resolveBuiltInSkillsPluginDir = Effect.fn("BuiltInSkills.resolvePluginDir")(function* (
  env: Readonly<Record<string, string | undefined>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = [
    env[BUILT_IN_SKILLS_DIR_ENV_VAR],
    // src/skills/ in the source tree, dist/ in a bundled server.
    path.resolve(import.meta.dirname, "../../skills"),
    path.resolve(import.meta.dirname, "../skills"),
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || /\.asar(?:[\\/]|$)/u.test(candidate)) {
      continue;
    }
    const found = yield* fileSystem
      .exists(path.join(candidate, ".claude-plugin", "plugin.json"))
      .pipe(Effect.orElseSucceed(() => false));
    if (found) return candidate;
  }
  return undefined;
});

/** The folder holding one directory per skill, which Codex takes as an extra skills root. */
export const builtInSkillsRoot = (path: Path.Path, pluginDir: string) =>
  path.join(pluginDir, "skills");

/** The plugin folders for a workspace: the built-in skills only show in edit projects. */
export const builtInSkillPluginDirsForCwd = Effect.fn("BuiltInSkills.pluginDirsForCwd")(function* (
  cwd: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (cwd === undefined) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* isVideoProjectFolder(fileSystem)(cwd))) return [];
  const pluginDir = yield* resolveBuiltInSkillsPluginDir(env);
  return pluginDir === undefined ? [] : [pluginDir];
});
