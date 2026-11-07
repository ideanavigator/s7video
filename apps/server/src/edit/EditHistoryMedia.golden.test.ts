// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The clip is made with ffmpeg and checked with fs, outside the code under test.
/**
 * Undo never touches media (S7V-024 AC-5, AC-7; S7V-051 AC-5). The clip is synthetic, made by
 * ffmpeg at test time in a temp folder and deleted afterwards. `pnpm test` uses a 24 MiB clip; the
 * full check is `S7V_EDIT_MEDIA_MIB=500 S7V_EDIT_BENCH=1 pnpm test:golden -- EditHistoryMedia`.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EditOp } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import * as EditHistoryService from "./EditHistoryService.ts";
import { HISTORY_DIR, projectFileContents } from "./EditProjectLayout.ts";
import { layerEditTest } from "./editHarness.testkit.ts";

const CLIP_MIB = Number(process.env.S7V_EDIT_MEDIA_MIB ?? "24");
const BENCH = process.env.S7V_EDIT_BENCH === "1";
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find(
  (candidate) => NodeFS.existsSync(candidate),
);
const FRAME_BYTES = 1920 * 1080 * 1.5;

/** Raw 1080p frames: fast to write and exactly as large as asked. */
const makeClip = (file: string, mib: number, size = "1920x1080") => {
  const frames = Math.ceil((mib * 1024 * 1024) / FRAME_BYTES);
  NodeChildProcess.execFileSync(FFMPEG!, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=30`,
    "-frames:v",
    String(frames),
    "-c:v",
    "rawvideo",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
};

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};
// oxlint-disable-next-line t3code/no-wall-clock-in-tests -- Benchmark, only behind S7V_EDIT_BENCH.
const now = () => performance.now();

const setup: ReadonlyArray<EditOp> = [
  {
    _tag: "putMedia",
    media: {
      id: "clip",
      kind: "video",
      path: "assets/clip.mov",
      fingerprint: { sha256: "ef".repeat(32), size: 1 },
      probe: { durationFrames: 100_000, hasVideo: true, hasAudio: false },
    },
  },
  { _tag: "addTrack", track: { kind: "video", id: "V1", items: [] } },
];
const keep = (duration: number): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "clip",
  ranges: [{ in: 0, duration }],
});
/** About 20 KiB of edit.json: many short kept ranges, as after a silence cut. */
const keepMany = (length: number): EditOp => ({
  _tag: "setKeepRanges",
  trackId: "V1",
  mediaId: "clip",
  ranges: Array.from({ length: 150 }, (_, index) => ({ in: index * 40, duration: length })),
});

/** Every file under `.s7history/`, with its size. */
const historyFiles = (root: string) =>
  NodeFS.readdirSync(NodePath.join(root, HISTORY_DIR), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodeFS.statSync(NodePath.join(entry.parentPath, entry.name)).size);

describe.skipIf(FFMPEG === undefined)("edit history with media in the project", () => {
  it.live(
    "keeps the clip and proxy untouched and out of the history across capture and restore",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-edit-media-" });
        yield* Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const edits = yield* EditDocumentService.EditDocumentService;
          const history = yield* EditHistoryService.EditHistoryService;
          const { projectId, workspaceRoot: root } = yield* folders.createNamedProject({
            name: "Media test",
          });
          const clip = NodePath.join(root, "assets", "clip.mov");
          const proxy = NodePath.join(root, ".s7cache", "proxies", "clip.540p.mov");
          makeClip(clip, CLIP_MIB);
          NodeFS.mkdirSync(NodePath.dirname(proxy), { recursive: true });
          makeClip(proxy, Math.max(1, Math.round(CLIP_MIB / 8)), "960x540");
          const files = [clip, proxy].map((file) => ({ file, before: NodeFS.statSync(file) }));
          assert.isAtLeast(files[0]!.before.size, CLIP_MIB * 1024 * 1024);

          let snapshot = yield* edits.read(projectId);
          for (const ops of [setup, [keep(300)], [keepMany(20)], [keepMany(30)]]) {
            snapshot = yield* edits.apply(projectId, ops, {
              origin: "agent",
              baseRevision: snapshot.revision,
            });
          }
          const editBytes = NodeFS.statSync(NodePath.join(root, "edit.json")).size;
          assert.isAtLeast(editBytes, 18 * 1024);
          yield* edits.undo(projectId);
          yield* edits.undo(projectId);
          yield* edits.redo(projectId);

          const checkUntouched = () => {
            for (const { file, before } of files) {
              const after = NodeFS.statSync(file);
              assert.strictEqual(after.ino, before.ino, file);
              assert.strictEqual(after.mtimeMs, before.mtimeMs, file);
              assert.strictEqual(after.size, before.size, file);
            }
            // Only compressed copies of edit.json and project.json: no file near a clip's size.
            const sizes = historyFiles(root);
            const total = sizes.reduce((sum, size) => sum + size, 0);
            assert.isBelow(Math.max(...sizes), 64 * 1024);
            assert.isBelow(total, 1024 * 1024, `.s7history holds ${total} bytes`);
            return total;
          };
          checkUntouched();

          if (!BENCH) return;
          const editFile = NodePath.join(root, "edit.json");
          // Restore as undo does it, through the whole edit service (validation, library rule, writes).
          const undoMs: number[] = [];
          for (let run = 0; run < 20; run++) {
            const start = now();
            yield* run % 2 === 0 ? edits.undo(projectId) : edits.redo(projectId);
            undoMs.push(now() - start);
          }
          // Restore in the history layer: read the saved edit.json and write it back atomically.
          const restoreMs: number[] = [];
          for (let run = 0; run < 20; run++) {
            const start = now();
            yield* history.step(root, run % 2 === 0 ? "undo" : "redo", (text) =>
              Effect.sync(() => {
                const temp = `${editFile}.bench.tmp`;
                const handle = NodeFS.openSync(temp, "w");
                NodeFS.writeSync(handle, text);
                NodeFS.fsyncSync(handle);
                NodeFS.closeSync(handle);
                NodeFS.renameSync(temp, editFile);
                return text;
              }),
            );
            restoreMs.push(now() - start);
          }
          // Capture as a change records it: a new edit.json and project.json, saved with the log.
          const captureMs: number[] = [];
          const base = NodeFS.readFileSync(editFile, "utf8");
          for (let run = 0; run < 20; run++) {
            const revision = 1000 + run;
            const text = base.replace(/\n\}\n$/u, `,\n  "bench": ${run}\n}\n`);
            NodeFS.writeFileSync(
              NodePath.join(root, "project.json"),
              projectFileContents(revision),
            );
            const start = now();
            yield* history.record(root, revision, text);
            captureMs.push(now() - start);
          }
          const historyBytes = checkUntouched();
          const result = {
            clipMiB: CLIP_MIB,
            editKiB: Math.round(editBytes / 1024),
            historyBytes,
            captureMedianMs: Math.round(median(captureMs) * 10) / 10,
            restoreMedianMs: Math.round(median(restoreMs) * 10) / 10,
            undoMedianMs: Math.round(median(undoMs) * 10) / 10,
            captureMs: captureMs.map(Math.round),
            restoreMs: restoreMs.map(Math.round),
            undoMs: undoMs.map(Math.round),
          };
          process.stdout.write(`[S7V-051 bench] ${JSON.stringify(result)}\n`);
          assert.isAtMost(result.captureMedianMs, 30);
          assert.isAtMost(result.restoreMedianMs, 30);
          assert.isAtMost(result.undoMedianMs, 150);
        }).pipe(Effect.provide(layerEditTest(baseDir)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
