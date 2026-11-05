// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - checkFile reads a real temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { anchorsOf, checkFile, extractLinks, headingSlug } from "./check-doc-links.ts";

describe("extractLinks", () => {
  it("finds inline and reference links but skips code", () => {
    const markdown = [
      'See [a](a.md) and ![img](img.png "title").',
      "Inline `[not](code.md)` is ignored.",
      "```",
      "[also](ignored.md)",
      "```",
      "[ref]: ./docs/b.md#part",
    ].join("\n");
    expect(extractLinks(markdown)).toEqual([
      { line: 1, target: "a.md" },
      { line: 1, target: "img.png" },
      { line: 6, target: "./docs/b.md#part" },
    ]);
  });
});

describe("anchors", () => {
  it("slugs headings the way GitHub does, numbering duplicates", () => {
    expect(headingSlug("Quick start (development)")).toBe("quick-start-development");
    expect(headingSlug("Sign off every commit (DCO)")).toBe("sign-off-every-commit-dco");
    expect(headingSlug("Foo_bar and `code`")).toBe("foo_bar-and-code");
    expect([...anchorsOf('# Setup\n## Setup\n<a id="custom"></a>')]).toEqual([
      "setup",
      "setup-1",
      "custom",
    ]);
  });
});

describe("checkFile", () => {
  it("reports missing files and missing anchors, and accepts URLs", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doc-links-"));
    try {
      NodeFS.writeFileSync(NodePath.join(root, "target.md"), "# Real heading\n");
      NodeFS.writeFileSync(
        NodePath.join(root, "index.md"),
        [
          "[ok](target.md#real-heading)",
          "[gone](missing.md)",
          "[bad anchor](target.md#nope)",
          "[web](https://example.com/x.md)",
          "[mail](mailto:someone@example.com)",
          "[bad encoding](%zz.md)",
        ].join("\n"),
      );
      expect(checkFile(root, "index.md")).toEqual([
        "2: missing.md (no such file)",
        '3: target.md#nope (no heading or anchor "#nope")',
        "6: %zz.md (malformed URL encoding)",
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
