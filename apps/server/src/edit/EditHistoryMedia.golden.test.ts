// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- The clip is made with ffmpeg and checked with git and fs, outside the code under test.
/**
 * Undo never touches media (S7V-024 AC-5, AC-7). The clip is synthetic, made by ffmpeg at test
 * time in a temp folder and deleted afterwards. `pnpm test` uses a 24 MiB clip; the full check is
 * `S7V_EDIT_MEDIA_MIB=500 S7V_EDIT_BENCH=1 pnpm test:golden -- EditHistoryMedia`.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef, type EditOp } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EditDocumentService from "./EditDocumentService.ts";
import { git, layerEditTest } from "./editHarness.testkit.ts";

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

const duBytes = (dir: string) =>
  Number(NodeChildProcess.execFileSync("du", ["-sk", dir]).toString().split(/\s+/)[0]) * 1024;
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

describe.skipIf(FFMPEG === undefined)("edit history with media in the project", () => {
  it.live("keeps the clip and proxy untouched and out of git across capture and restore", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-edit-media-" });
      yield* Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const edits = yield* EditDocumentService.EditDocumentService;
        const store = yield* CheckpointStore.CheckpointStore;
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
        const gitBefore = duBytes(NodePath.join(root, ".git"));

        let snapshot = yield* edits.read(projectId);
        for (const ops of [setup, [keep(300)], [keep(150)]]) {
          snapshot = yield* edits.apply(projectId, ops, {
            origin: "agent",
            baseRevision: snapshot.revision,
          });
        }
        yield* edits.undo(projectId);
        yield* edits.undo(projectId);
        yield* edits.redo(projectId);

        for (const { file, before } of files) {
          const after = NodeFS.statSync(file);
          assert.strictEqual(after.ino, before.ino, file);
          assert.strictEqual(after.mtimeMs, before.mtimeMs, file);
          assert.strictEqual(after.size, before.size, file);
        }
        const growth = duBytes(NodePath.join(root, ".git")) - gitBefore;
        assert.isBelow(growth, 1024 * 1024, `.git grew ${growth} bytes`);
        const objects = git(root, "rev-list", "--objects", "--all");
        for (const { file } of files) {
          const blob = git(root, "hash-object", "--", file).trim();
          assert.notInclude(objects, blob, file);
        }

        if (!BENCH) return;
        const captureMs: number[] = [];
        const restoreMs: number[] = [];
        const refs = [0, 1].map((n) => CheckpointRef.make(`refs/t3/edit/bench/${n}`));
        for (let run = 0; run < 10; run++) {
          NodeFS.writeFileSync(NodePath.join(root, "styles", "bench.json"), `{"run":${run}}\n`);
          const captureStart = now();
          yield* store.captureCheckpoint({ cwd: root, checkpointRef: refs[run % 2]! });
          captureMs.push(now() - captureStart);
        }
        // Restore as undo does it: edit.json from the checkpoint, written with a new revision.
        for (let run = 0; run < 10; run++) {
          const restoreStart = now();
          yield* run % 2 === 0 ? edits.undo(projectId) : edits.redo(projectId);
          restoreMs.push(now() - restoreStart);
        }
        const result = {
          clipMiB: CLIP_MIB,
          gitGrowthBytes: growth,
          captureMedianMs: Math.round(median(captureMs)),
          restoreMedianMs: Math.round(median(restoreMs)),
          captureMs: captureMs.map(Math.round),
          restoreMs: restoreMs.map(Math.round),
        };
        process.stdout.write(`[S7V-024 bench] ${JSON.stringify(result)}\n`);
        assert.isAtMost(result.captureMedianMs, 200);
        assert.isAtMost(result.restoreMedianMs, 150);
      }).pipe(Effect.provide(layerEditTest(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
