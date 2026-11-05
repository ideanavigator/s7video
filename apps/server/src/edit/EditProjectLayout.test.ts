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
import { git, isIgnored, layerEditTest } from "./editTestHarness.ts";

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
});
