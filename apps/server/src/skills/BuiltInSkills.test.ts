// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { EDIT_FILE, PROJECT_FILE } from "../edit/EditProjectLayout.ts";
import { planClaudeSkillDispatch } from "../provider/Drivers/ClaudeSkillDispatch.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import {
  builtInSkillPluginDirsForCwd,
  builtInSkillsRoot,
  resolveBuiltInSkillsPluginDir,
} from "./BuiltInSkills.ts";

const sourcePluginDir = Effect.map(Path.Path, (path) =>
  path.resolve(import.meta.dirname, "../../skills"),
);

const makeEditProject = Effect.fn(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(cwd, EDIT_FILE), "{}\n");
  yield* fs.writeFileString(path.join(cwd, PROJECT_FILE), "{}\n");
});

it.layer(NodeServices.layer)("built-in skills", (it) => {
  it.effect("should find the skills folder in the source tree", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveBuiltInSkillsPluginDir({}), yield* sourcePluginDir);
    }),
  );

  it.effect("should find the skills folder when packaged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resources = yield* fs.makeTempDirectoryScoped({ prefix: "s7-skills-resources-" });
      const packaged = path.join(resources, "skills");
      yield* fs.copy(yield* sourcePluginDir, packaged);

      assert.equal(
        yield* resolveBuiltInSkillsPluginDir({ S7VIDEO_SKILLS_DIR: packaged }),
        packaged,
      );
      // A folder inside app.asar cannot be read by the agent CLIs, so it never counts.
      assert.equal(
        yield* resolveBuiltInSkillsPluginDir({
          S7VIDEO_SKILLS_DIR: path.join(resources, "app.asar", "skills"),
        }),
        yield* sourcePluginDir,
      );
      // Relative values depend on the working directory, so they are ignored too.
      assert.equal(
        yield* resolveBuiltInSkillsPluginDir({ S7VIDEO_SKILLS_DIR: "skills" }),
        yield* sourcePluginDir,
      );
    }),
  );

  it.effect("should hide built-in skills outside video projects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "s7-skills-cwd-" });
      assert.deepEqual(yield* builtInSkillPluginDirsForCwd(cwd, {}), []);
      assert.deepEqual(yield* builtInSkillPluginDirsForCwd(undefined, {}), []);

      yield* makeEditProject(cwd);
      assert.deepEqual(yield* builtInSkillPluginDirsForCwd(cwd, {}), [yield* sourcePluginDir]);
    }),
  );

  it.effect("discoverClaudeSkills lists built-in skills without touching the user's config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "s7-skills-home-" });
      const pluginDir = yield* sourcePluginDir;

      const skills = yield* discoverClaudeSkills({ homePath: home }, undefined, {}, [pluginDir]);
      assert.deepEqual(skills, [
        {
          name: "video:remove-silences",
          path: path.join(builtInSkillsRoot(path, pluginDir), "remove-silences", "SKILL.md"),
          enabled: true,
          scope: "system",
          description:
            "Remove silences - cut the pauses from the user's clip. Use only when the user asks for it.",
          displayName: "Remove silences",
        },
      ]);
      assert.deepEqual(yield* fs.readDirectory(home), []);
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: home }, undefined, {}), []);

      // The composer's `$video:remove-silences` reaches Claude as its slash command.
      assert.deepEqual(
        planClaudeSkillDispatch("$video:remove-silences", new Map(skills.map((s) => [s.name, s]))),
        { leadingText: undefined, commandText: "/video:remove-silences" },
      );
    }),
  );

  it.effect("should transcribe before cutting and never touch edit.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const text = yield* fs.readFileString(
        path.join(builtInSkillsRoot(path, yield* sourcePluginDir), "remove-silences", "SKILL.md"),
      );
      const order = ["video_transcribe", "video_job_status", "video_remove_silences"].map((tool) =>
        text.indexOf(`\`${tool}\``),
      );
      assert.isTrue(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!)));
      // S7V-058: the agent waits out a long first transcription instead of giving up.
      assert.include(text, "`waitSeconds: 30`");
      assert.include(text, "do not end your turn");
      assert.include(text, "Say undo to put it back.");
      assert.include(text, "Never edit `edit.json` yourself and never use git on it.");
    }),
  );
});
