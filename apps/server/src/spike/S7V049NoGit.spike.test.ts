// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Spike S7V-049: never merged.
/**
 * Spike S7V-049: how the real project, edit and undo services behave when git is the Apple shim
 * (no Command Line Tools), missing, or has no identity. Temp dirs only.
 */
import { describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EditOp } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "../edit/EditDocumentService.ts";
import { layerEditTest } from "../edit/editHarness.testkit.ts";

const SHIM_NOTE =
  "xcode-select: note: No developer tools were found, requesting install.\n" +
  "If developer tools are located at a non-default location on disk, use `sudo xcode-select --switch path/to/Xcode.app` to specify the Xcode that you wish to use for command line developer tools, and cancel the installation dialog.\n" +
  "See `man xcode-select` for more details.\n";

const setupOps: ReadonlyArray<EditOp> = [
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];

const run = (label: string, env: Record<string, string | undefined>, afterCreatePath?: string) =>
  Effect.gen(function* () {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v049-" });
    const report: Record<string, unknown> = { label };
    yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const created = yield* Effect.exit(folders.createNamedProject({ name: "Clean Mac" }));
      if (Exit.isFailure(created)) {
        report.createNamedProject = `FAILED: ${String(created.cause).slice(0, 400)}`;
        return;
      }
      const { projectId, workspaceRoot, commitError } = created.value;
      report.createNamedProject =
        commitError === undefined ? "ok" : `ok, commitError: ${commitError}`;
      report.files = NodeFS.readdirSync(workspaceRoot).sort();
      if (afterCreatePath !== undefined) process.env.PATH = afterCreatePath;
      const read = yield* Effect.exit(edits.read(projectId));
      report.read = Exit.isSuccess(read)
        ? `ok rev ${read.value.revision}`
        : `FAILED: ${String(read.cause).slice(0, 300)}`;
      if (Exit.isFailure(read)) return;
      const applied = yield* Effect.exit(
        edits.apply(projectId, setupOps, { origin: "agent", baseRevision: read.value.revision }),
      );
      report.apply = Exit.isSuccess(applied)
        ? `ok rev ${applied.value.revision}`
        : `FAILED: ${String(applied.cause).slice(0, 400)}`;
      const undone = yield* Effect.exit(edits.undo(projectId));
      report.undo = Exit.isSuccess(undone)
        ? `ok rev ${undone.value.revision}`
        : `FAILED: ${String(undone.cause).slice(0, 300)}`;
    }).pipe(Effect.provide(layerEditTest(baseDir)));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.stdout.write(`[S7V-049] ${JSON.stringify(report, null, 1)}\n`);
  }).pipe(Effect.scoped);

describe("S7V-049 no developer tools", () => {
  it.live("reports each case", () =>
    Effect.gen(function* () {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v049-bin-"));
      const shimDir = NodePath.join(tmp, "shim");
      NodeFS.mkdirSync(shimDir);
      // Behaves like /usr/bin/git without CLT: prints the note, exits 1 (and would open the dialog).
      NodeFS.writeFileSync(
        NodePath.join(shimDir, "git"),
        `#!/bin/sh\necho "$@" >> "${tmp}/shim-calls.log"\ncat >&2 <<'NOTE'\n${SHIM_NOTE}NOTE\nexit 1\n`,
        { mode: 0o755 },
      );
      const emptyDir = NodePath.join(tmp, "empty");
      NodeFS.mkdirSync(emptyDir);
      const emptyHome = NodePath.join(tmp, "home");
      NodeFS.mkdirSync(emptyHome);
      const realGitDir = NodePath.dirname("/usr/bin/git");

      yield* run("apple-shim (no CLT)", { PATH: `${shimDir}:/bin` });
      const calls = NodeFS.existsSync(`${tmp}/shim-calls.log`)
        ? NodeFS.readFileSync(`${tmp}/shim-calls.log`, "utf8").trim().split("\n")
        : [];
      process.stdout.write(
        `[S7V-049] shim was spawned ${calls.length} times: ${JSON.stringify(calls.slice(0, 12))}\n`,
      );
      yield* run("no git on PATH", { PATH: emptyDir });
      yield* run("real git, empty HOME, no identity", {
        PATH: `${realGitDir}:/bin`,
        HOME: emptyHome,
        XDG_CONFIG_HOME: emptyHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        EMAIL: undefined,
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      });
      yield* run(
        "project made with git, then git is the shim",
        { PATH: `${realGitDir}:/bin` },
        `${shimDir}:/bin`,
      );
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
