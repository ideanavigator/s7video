// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The old git history is built with plain git calls.
/**
 * S7V-051 AC-7: an S7V-024 project (`.s7cache/edit-history.json` and `refs/t3/edit/checkpoints/*`)
 * is imported once. The git access here stands in for S7V-052's no-spawn probe, which wires the
 * same `LegacyEditHistory.make` in the server.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EditOp, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { git, historyLog, layerEditTest, type SpawnCounter } from "./editHarness.testkit.ts";
import * as LegacyEditHistory from "./LegacyEditHistory.ts";

const setup: ReadonlyArray<EditOp> = [
  {
    _tag: "putMedia",
    media: {
      id: "cam",
      kind: "video",
      path: "assets/cam.mp4",
      fingerprint: { sha256: "ab".repeat(32), size: 4096 },
      probe: { durationFrames: 900, hasVideo: true, hasAudio: true },
    },
  },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];
const keep = (duration: number): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "cam",
  ranges: [{ in: 0, duration }],
});

const read = (root: string, file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Writes `steps` as S7V-024 left them: one commit per step under refs/t3/edit/checkpoints/. */
const writeOldHistory = (
  root: string,
  steps: ReadonlyArray<{ readonly edit: string; readonly project: string }>,
  cursor: number,
) => {
  const blob = (text: string) =>
    NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: text,
    })
      .toString()
      .trim();
  const entries = steps.map((step, index) => {
    const tree = NodeChildProcess.execFileSync("git", ["mktree"], {
      cwd: root,
      input: `100644 blob ${blob(step.edit)}\tedit.json\n100644 blob ${blob(step.project)}\tproject.json\n`,
    })
      .toString()
      .trim();
    const commit = git(root, "commit-tree", tree, "-m", `edit ${index + 1}`).trim();
    const ref = `refs/t3/edit/checkpoints/${index + 1}`;
    git(root, "update-ref", ref, commit);
    return { seq: index + 1, revision: JSON.parse(step.project).revision, ref };
  });
  NodeFS.rmSync(NodePath.join(root, ".s7history"), { recursive: true, force: true });
  NodeFS.writeFileSync(NodePath.join(root, "edit.json"), steps[cursor]!.edit);
  NodeFS.writeFileSync(NodePath.join(root, "project.json"), steps[cursor]!.project);
  const state = {
    version: 1,
    nextSeq: steps.length + 1,
    highestRevision: Math.max(...entries.map((entry) => entry.revision)),
    cursor,
    entries,
    knownEdit: sha256(steps[cursor]!.edit),
  };
  NodeFS.writeFileSync(
    NodePath.join(root, ".s7cache", "edit-history.json"),
    `${JSON.stringify(state)}\n`,
  );
};

const withOldProject = <A, E>(
  gitWorks: boolean,
  body: (input: {
    readonly root: string;
    readonly edits: EditDocumentService.EditDocumentService["Service"];
    readonly projectId: ProjectId;
    readonly steps: ReadonlyArray<{ readonly edit: string; readonly project: string }>;
    readonly shows: { count: number };
    readonly spawns: SpawnCounter;
  }) => Effect.Effect<A, E>,
) => {
  const shows = { count: 0 };
  const spawns: SpawnCounter = { count: 0 };
  const legacy = Layer.effect(
    LegacyEditHistory.LegacyEditHistory,
    LegacyEditHistory.make({
      available: Effect.succeed(gitWorks),
      show: (cwd, ref, file) =>
        Effect.sync(() => {
          shows.count += 1;
          try {
            return Option.some(git(cwd, "show", `${ref}:${file}`));
          } catch {
            return Option.none();
          }
        }),
    }),
  );
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-legacy-" });
    return yield* Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const edits = yield* EditDocumentService.EditDocumentService;
      const { projectId, workspaceRoot: root } = yield* folders.createNamedProject({
        name: "Old project",
      });
      // Make four real edit versions with the service, then rewrite them in the old format.
      let snapshot = yield* edits.read(projectId);
      const steps = [{ edit: read(root, "edit.json"), project: read(root, "project.json") }];
      for (const ops of [[...setup, keep(300)], [keep(90)], [keep(30)]]) {
        snapshot = yield* edits.apply(projectId, ops, {
          origin: "agent",
          baseRevision: snapshot.revision,
        });
        steps.push({ edit: read(root, "edit.json"), project: read(root, "project.json") });
      }
      writeOldHistory(root, steps, 2);
      shows.count = 0;
      spawns.count = 0;
      return yield* body({ root, edits, projectId, steps, shows, spawns });
    }).pipe(Effect.provide(layerEditTest(baseDir, undefined, { legacy, spawns })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
};

describe("LegacyEditHistory", () => {
  it.effect("imports an old git history once when git is present", () =>
    withOldProject(true, ({ root, edits, projectId, steps, shows }) =>
      Effect.gen(function* () {
        const refs = git(root, "for-each-ref", "refs/t3/edit");
        const oldFile = read(root, ".s7cache/edit-history.json");

        const opened = yield* edits.read(projectId);
        assert.isTrue(opened.canUndo && opened.canRedo);
        assert.strictEqual(opened.revision, JSON.parse(steps[2]!.project).revision);
        assert.strictEqual(shows.count, 8);
        const log = historyLog(root)!;
        assert.strictEqual(log.entries.length, 4);
        assert.strictEqual(log.cursor, 2);

        yield* edits.undo(projectId);
        assert.strictEqual(read(root, "edit.json"), steps[1]!.edit);
        yield* edits.redo(projectId);
        yield* edits.redo(projectId);
        assert.strictEqual(read(root, "edit.json"), steps[3]!.edit);
        assert.strictEqual(shows.count, 8, "imported once");

        assert.strictEqual(git(root, "for-each-ref", "refs/t3/edit"), refs);
        assert.strictEqual(read(root, ".s7cache/edit-history.json"), oldFile);
      }),
    ),
  );

  it.effect("starts fresh when old history exists but no working git", () =>
    withOldProject(false, ({ root, edits, projectId, shows, spawns }) =>
      Effect.gen(function* () {
        const oldFile = read(root, ".s7cache/edit-history.json");
        const opened = yield* edits.read(projectId);
        assert.isFalse(opened.canUndo);
        const changed = yield* edits.apply(projectId, [keep(60)], {
          origin: "agent",
          baseRevision: opened.revision,
        });
        assert.isTrue(changed.canUndo);
        assert.strictEqual(historyLog(root)!.entries.length, 2);
        assert.strictEqual(shows.count, 0);
        assert.strictEqual(spawns.count, 0);
        assert.strictEqual(read(root, ".s7cache/edit-history.json"), oldFile);
      }),
    ),
  );
});
