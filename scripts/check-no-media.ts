// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain repository scan; no Effect runtime.
// Fails when git tracks (or has staged) an audio or video file, or a model-weights file over
// 5 MiB. Test media is downloaded into a cache by `pnpm media:fetch` and model weights are
// downloaded at runtime; neither is ever committed (S7V-031). Run by `pnpm licenses:check`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MEDIA_EXTENSIONS = new Set(
  "mp4 m4v mov mkv webm avi wmv flv mxf mts m2ts 3gp mpg mpeg m4a wav mp3 aac flac ogg oga opus aif aiff caf wma".split(
    " ",
  ),
);
const WEIGHT_EXTENSIONS = new Set(["safetensors", "npz", "gguf", "ckpt", "pt", "pth", "onnx"]);
export const WEIGHTS_SIZE_LIMIT = 5 * 1024 * 1024;

// UI sounds the app ships; each is CC0-1.0 and annotated in REUSE.toml. Nothing else may be added
// here without the same licence record.
export const ALLOWED_MEDIA: ReadonlySet<string> = new Set([
  "apps/web/src/assets/notification-completion.mp3",
  "apps/web/src/assets/notification-input.mp3",
  "apps/web/src/assets/snap-shot-click.mp3",
  "apps/web/src/assets/snap-shot-whoosh.mp3",
]);

export interface TrackedFile {
  readonly path: string;
  readonly size: number;
}

/** Each tracked file that breaks the rule, with the reason. */
export function findForbiddenFiles(
  files: ReadonlyArray<TrackedFile>,
  allowed: ReadonlySet<string> = ALLOWED_MEDIA,
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const ext = NodePath.extname(file.path).slice(1).toLowerCase();
    if (MEDIA_EXTENSIONS.has(ext) && !allowed.has(file.path)) {
      problems.push(`${file.path}: audio or video file (test media is fetched, never committed)`);
    } else if (WEIGHT_EXTENSIONS.has(ext) && file.size > WEIGHTS_SIZE_LIMIT) {
      problems.push(`${file.path}: looks like model weights (${file.size} bytes)`);
    }
  }
  return problems;
}

/** Files in the git index of `root` (tracked or staged), with their working-tree size. */
export function trackedFiles(root: string): TrackedFile[] {
  const output = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      try {
        return { path, size: NodeFS.statSync(NodePath.join(root, path)).size };
      } catch {
        return { path, size: 0 };
      }
    });
}

/** Prints problems and returns the exit code. */
export function checkNoMedia(root: string): number {
  const problems = findForbiddenFiles(trackedFiles(root));
  for (const problem of problems) console.error(`error: ${problem}`);
  if (problems.length > 0) {
    console.error(
      `check-no-media failed: ${problems.length} file(s). Remove them with \`git rm --cached\`; see docs/engineering/testing.md#test-media.`,
    );
    return 1;
  }
  console.log("check-no-media: no media or model weights tracked.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = checkNoMedia(NodePath.resolve(import.meta.dirname, ".."));
}
