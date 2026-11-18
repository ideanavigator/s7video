// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Writes a scratch archive.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { verifyArchive } from "./build-engine-runtime.ts";

describe("build-engine-runtime", () => {
  it("a wrong sha256 or size stops the build", () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-runtime-"));
    try {
      const file = NodePath.join(folder, "cpython.tar.gz");
      NodeFS.writeFileSync(file, "not the pinned archive");
      const sha256 = NodeCrypto.createHash("sha256").update("not the pinned archive").digest("hex");
      expect(() => verifyArchive(file, { url: "https://x/a", sha256, size: 22 })).not.toThrow();
      expect(() =>
        verifyArchive(file, { url: "https://x/a", sha256: "0".repeat(64), size: 22 }),
      ).toThrow("but packages/engine/runtime/runtime.lock.json pins 0000");
      expect(() => verifyArchive(file, { url: "https://x/a", sha256, size: 23 })).toThrow(
        "(23 bytes)",
      );
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });
});
