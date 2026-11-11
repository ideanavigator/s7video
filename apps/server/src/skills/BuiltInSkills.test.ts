// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { EDIT_FILE, PROJECT_FILE, projectFileContents } from "../edit/EditProjectLayout.ts";
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
  yield* fs.writeFileString(path.join(cwd, PROJECT_FILE), projectFileContents(0));
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
          name: "video:add-captions",
          path: path.join(builtInSkillsRoot(path, pluginDir), "add-captions", "SKILL.md"),
          enabled: true,
          scope: "system",
          description:
            "Add captions - put captions in the user's video edit. Use only when the user asks for it.",
          displayName: "Add captions",
        },
        {
          name: "video:add-sound-and-music",
          path: path.join(builtInSkillsRoot(path, pluginDir), "add-sound-and-music", "SKILL.md"),
          enabled: true,
          scope: "system",
          description:
            "Add sound and music - place the user's SFX and music. Use only if the user asks.",
          displayName: "Add sound and music",
        },
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
      for (const state of ["`succeeded`: go on", "`failed`: tell the user", "`cancelled`:"]) {
        assert.include(text, state);
      }
      assert.include(text, "Never start a\n     transcription the user cancelled again.");
      // Whitespace collapsed, so re-wrapping the skill text does not break these checks.
      const flat = text.replace(/\s+/g, " ");
      // S7V-056 round 2: the undo offer only follows a call that cut something.
      assert.include(
        flat,
        'When the result says `changed: true`, end with: "Say undo to put it back."',
      );
      assert.include(
        flat,
        "(`changed: false`), say the edit is unchanged and do not offer that undo.",
      );
      // S7V-056: an already-cut keep is passed on with an offer to undo back to before that cut.
      assert.include(flat, "was cut by an earlier edit");
      assert.include(flat, "offer to undo back to before that cut, then ask again");
      assert.include(flat, "never by frame numbers");
      // S7V-061: editing never exports; captions come with the export the user asks for.
      assert.include(flat, "Do not export.");
      assert.include(flat, "Call `video_export` only when this message asks for a video file");
      assert.include(flat, "Call `video_canvas` only when the user names a shape");
      // S7V-055: a still-measuring silence job is waited out; the cut is retried only on success.
      assert.include(
        flat,
        "If it says the sound is still being measured, call `video_job_status` with that `jobId` and `waitSeconds: 30` until the job ends. If it `succeeded`, call `video_remove_silences` again; if it `failed` or was `cancelled`, tell the user and stop.",
      );
      assert.include(text, "Never edit `edit.json` yourself and never use git on it.");
    }),
  );
});
