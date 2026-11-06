// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - sha256 over two MiB of the file; Effect has no hash.
// A media file's identity for caches (ADR-005): sha256 over its first and last MiB, plus its size.
// Reading 2 MiB keeps it instant for multi-GB clips; the size catches most edits in the middle.
import * as NodeCrypto from "node:crypto";

import type { MediaFingerprint } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

const MIB = 1024 * 1024;

const readAt = Effect.fnUntraced(function* (file: FileSystem.File, position: number, size: number) {
  const parts: Uint8Array[] = [];
  let read = 0;
  while (read < size) {
    const chunk = yield* file.readAlloc(size - read, { position: BigInt(position + read) });
    if (Option.isNone(chunk) || chunk.value.length === 0) break;
    parts.push(chunk.value);
    read += chunk.value.length;
  }
  return parts;
});

/** Files of 2 MiB or less are hashed whole; larger ones as first MiB then last MiB. */
export const mediaFingerprint = Effect.fn("mediaFingerprint")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(path, { flag: "r" });
      const size = Number((yield* file.stat).size);
      const hash = NodeCrypto.createHash("sha256");
      const ranges: Array<readonly [number, number]> =
        size <= 2 * MIB
          ? [[0, size]]
          : [
              [0, MIB],
              [size - MIB, MIB],
            ];
      for (const [position, length] of ranges) {
        for (const part of yield* readAt(file, position, length)) hash.update(part);
      }
      return { sha256: hash.digest("hex"), size } satisfies MediaFingerprint;
    }),
  );
});
