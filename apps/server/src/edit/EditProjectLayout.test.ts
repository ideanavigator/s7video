// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Assertions read the project folder and git directly.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as EditProjectLayout from "./EditProjectLayout.ts";
import { git, isIgnored, layerEditTest } from "./editHarness.testkit.ts";

const withRoot = <A, E>(
  body: (
    root: string,
  ) => Effect.Effect<
    A,
    E,
    EditProjectLayout.EditProjectLayout | ProjectFaviconResolver.ProjectFaviconResolver
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-layout-" });
    const root = NodePath.join(baseDir, "project");
    NodeFS.mkdirSync(root);
    return yield* body(root).pipe(Effect.provide(layerEditTest(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("EditProjectLayout", () => {
  it.effect("whitelist gitignore ignores media folders", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const layout = yield* EditProjectLayout.EditProjectLayout;
        git(root, "init", "--quiet");
        yield* layout.ensure(root);
        const ignored = [
          "assets/clip.mp4",
          "assets/clips/day1.mov",
          ".s7cache/proxies/clip.540p.mp4",
          "exports/final.mp4",
          "clip-at-root.mp4",
          "notes.txt",
          ".s7history/log.json",
          ".s7history/objects/ab.json.gz",
        ];
        const tracked = [
          "edit.json",
          "project.json",
          ".gitignore",
          "styles/brand.json",
          "README.md",
          "assets/icon.svg",
        ];
        for (const file of ignored) assert.isTrue(isIgnored(root, file), file);
        for (const file of tracked) assert.isFalse(isIgnored(root, file), file);
        // The media guard checks TRACKED_PATHS without git, so it must cover what git tracks.
        for (const file of tracked) {
          const covered = EditProjectLayout.TRACKED_PATHS.some((entry) =>
            entry.endsWith("/") ? file.startsWith(entry) : file === entry,
          );
          assert.isTrue(covered, file);
        }
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(root, ".gitignore"), "utf8"),
          EditProjectLayout.WHITELIST_GITIGNORE,
        );
      }),
    ),
  );

  it.effect("should keep scaffold README and icon tracked after layout upgrade", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const layout = yield* EditProjectLayout.EditProjectLayout;
        const favicons = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        // A project scaffolded before the layout existed, as ManagedProjectFolders made them.
        git(root, "init", "--quiet", "--initial-branch=main");
        NodeFS.writeFileSync(NodePath.join(root, "README.md"), "# Old project\n");
        NodeFS.mkdirSync(NodePath.join(root, "assets"));
        NodeFS.writeFileSync(NodePath.join(root, "assets", "icon.svg"), "<svg/>\n");
        NodeFS.writeFileSync(NodePath.join(root, "edit.json"), '{"keep":"mine"}\n');
        git(root, "add", "--force", "--", "README.md", "assets/icon.svg");
        git(root, "commit", "--quiet", "-m", "Initial commit");

        const written = yield* layout.ensure(root);
        assert.deepEqual(written, [".gitignore", "project.json"]);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(root, "edit.json"), "utf8"),
          '{"keep":"mine"}\n',
        );
        assert.deepEqual(yield* layout.ensure(root), []);
        git(root, "add", "-A");
        assert.deepEqual(git(root, "ls-files").trim().split("\n").sort(), [
          ".gitignore",
          "README.md",
          "assets/icon.svg",
          "edit.json",
          "project.json",
        ]);
        assert.isTrue(yield* layout.isEditProject(root));
        assert.strictEqual(
          yield* favicons.resolvePath(root),
          NodePath.join(root, "assets", "icon.svg"),
        );
      }),
    ),
  );

  // S7V-072: a video project hides every coding tool, so another tool's project.json must not count.
  it.effect("counts a folder as a video project only when project.json says edit-project", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const layout = yield* EditProjectLayout.EditProjectLayout;
        const isVideoProject = EditProjectLayout.isVideoProjectFolder(
          yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)),
        );
        assert.isFalse(yield* isVideoProject(root));
        yield* layout.ensure(root);
        assert.isTrue(yield* isVideoProject(root));
        const projectFile = NodePath.join(root, EditProjectLayout.PROJECT_FILE);
        // A later version or extra keys still count: only the format decides.
        NodeFS.writeFileSync(projectFile, '{"format":"edit-project","version":99,"extra":1}');
        assert.isTrue(yield* isVideoProject(root));
        for (const other of ['{"name":"app","targets":{}}', "{}", "not json", "[]"]) {
          NodeFS.writeFileSync(projectFile, other);
          assert.isFalse(yield* isVideoProject(root), other);
        }
        assert.isTrue(yield* layout.isEditProject(root));
      }),
    ),
  );
});
