// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Builds a throwaway git repo in a temp dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { findForbiddenFiles, trackedFiles, WEIGHTS_SIZE_LIMIT } from "./check-no-media.ts";

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) NodeFS.rmSync(repo, { recursive: true, force: true });
});

function tempRepo(files: Record<string, Buffer | string>): string {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-no-media-"));
  repos.push(repo);
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, path), content);
  }
  NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: repo });
  return repo;
}

describe("check-no-media", () => {
  it("passes a repo with code, images and the allowed UI sounds", () => {
    const repo = tempRepo({
      "src/a.ts": "export {};\n",
      "fixtures/images/landscape.heic": "heic",
      "apps/web/src/assets/notification-input.mp3": "mp3",
      "models/tiny.safetensors": "small",
    });
    expect(findForbiddenFiles(trackedFiles(repo))).toEqual([]);
  });

  it("should block tracked media", () => {
    const repo = tempRepo({ "fixtures/media/talking-head-01.mp4": "clip", "b/voice.WAV": "x" });
    expect(findForbiddenFiles(trackedFiles(repo))).toEqual([
      "b/voice.WAV: audio or video file (test media is fetched, never committed)",
      "fixtures/media/talking-head-01.mp4: audio or video file (test media is fetched, never committed)",
    ]);
  });

  it("should block model weights", () => {
    const big = Buffer.alloc(WEIGHTS_SIZE_LIMIT + 1);
    const repo = tempRepo({ "models/asr.safetensors": big, "models/x.gguf": big });
    expect(findForbiddenFiles(trackedFiles(repo))).toEqual([
      `models/asr.safetensors: looks like model weights (${big.length} bytes)`,
      `models/x.gguf: looks like model weights (${big.length} bytes)`,
    ]);
  });
});
