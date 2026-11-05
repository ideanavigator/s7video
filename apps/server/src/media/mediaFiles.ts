// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - statfs, positional reads and a byte-counted stream
// copy have no FileSystem equivalent, and the APFS clone needs `cp -c`.
/**
 * File work for imports. The source file is only ever read: never written, moved or touched.
 *
 * An APFS clone is decided before copying, not detected after: macOS `cp -c` quietly falls back to
 * a full copy across volumes, and Node's `COPYFILE_FICLONE` copies the bytes on macOS (S7V-025
 * confidence check 2). So `cp -c` runs only when source and target share one APFS volume.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeStreamPromises from "node:stream/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MIB = 1024 * 1024;
/** `statfs` `f_type` of APFS on macOS. */
const APFS_TYPE = 0x1a;

export class MediaFileError extends Schema.TaggedError<MediaFileError>()("MediaFileError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Media file ${this.operation} failed.`;
  }
}

const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new MediaFileError({ operation, cause }) });

/**
 * sha256 over the decimal size, a newline, the first MiB and the last MiB. Stable across copies
 * and moves, and cheap for any file size; a small file's two slices may overlap.
 */
export const fingerprint = (filePath: string) =>
  attempt("fingerprint", async () => {
    const handle = await NodeFSP.open(filePath, NodeFS.constants.O_RDONLY);
    try {
      const { size } = await handle.stat();
      const hash = NodeCrypto.createHash("sha256").update(`${size}\n`);
      const head = Buffer.alloc(Math.min(size, MIB));
      await handle.read(head, 0, head.length, 0);
      const tail = Buffer.alloc(Math.min(size, MIB));
      await handle.read(tail, 0, tail.length, size - tail.length);
      return { sha256: hash.update(head).update(tail).digest("hex"), size };
    } finally {
      await handle.close();
    }
  });

/** Bytes available to this user on the volume holding `folder`. */
export const freeBytes = (folder: string) =>
  attempt("free-space", async () => {
    const stats = await NodeFSP.statfs(folder);
    return Number(stats.bavail) * Number(stats.bsize);
  });

/** Whether `cp -c` can clone `source` into `folder`: the same device, and that device is APFS. */
export const canClone = (source: string, folder: string, platform: string) =>
  attempt("clone-check", async () => {
    const [sourceInfo, folderInfo, volume] = await Promise.all([
      NodeFSP.stat(source),
      NodeFSP.stat(folder),
      NodeFSP.statfs(folder),
    ]);
    return (
      platform === "darwin" &&
      sourceInfo.dev === folderInfo.dev &&
      Number(volume.type) === APFS_TYPE
    );
  });

export const cloneFile = (source: string, target: string) =>
  attempt(
    "clone",
    (signal) =>
      new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile("/bin/cp", ["-c", source, target], { signal }, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
  );

/** A byte-for-byte copy that reports progress (0..1); interrupting it stops the copy. */
export const streamCopy = (source: string, target: string, onProgress: (value: number) => void) =>
  attempt("copy", async (signal) => {
    const { size } = await NodeFSP.stat(source);
    let copied = 0;
    let reported = 0;
    const input = NodeFS.createReadStream(source, { highWaterMark: 4 * MIB });
    input.on("data", (chunk) => {
      copied += chunk.length;
      // About a hundred updates per file, however big it is.
      if (size > 0 && copied - reported >= size / 100) {
        reported = copied;
        onProgress(Math.min(copied / size, 1));
      }
    });
    await NodeStreamPromises.pipeline(input, NodeFS.createWriteStream(target, { flags: "wx" }), {
      signal,
    });
  });

/**
 * Gives `partial` its final name in `folder` without ever replacing a file: a hard link is an
 * exclusive create, so a taken name (a kept copy of a removed clip, a concurrent import of the same
 * name) moves on to `stem-2`, `stem-3`… Returns the name used; `partial` is gone afterwards.
 */
export const publishExclusive = (
  partial: string,
  folder: string,
  stem: string,
  extension: string,
) =>
  attempt("publish", async () => {
    for (let index = 1; ; index += 1) {
      const name = index === 1 ? `${stem}${extension}` : `${stem}-${index}${extension}`;
      try {
        await NodeFSP.link(partial, `${folder}/${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await NodeFSP.unlink(partial);
      return name;
    }
  });
