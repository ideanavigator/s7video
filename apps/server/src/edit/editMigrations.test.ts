// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Reads the shared migration fixture files.
import { EDIT_DOCUMENT_VERSION, validateEditDocument } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { EDIT_MIGRATIONS, migrateEditDocument } from "./editMigrations.ts";

const FIXTURES = NodeURL.fileURLToPath(
  new URL("../../../../fixtures/edit-documents/", import.meta.url),
);
const MIGRATIONS = `${FIXTURES}migrations/`;
const read = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));

describe("edit.json migrations", () => {
  it("migration harness refuses future version", () => {
    expect(migrateEditDocument(read(`${FIXTURES}16-future-version.json`))).toEqual({
      _tag: "future",
      version: 2,
    });
    expect(migrateEditDocument({ version: 1.5 })).toEqual({ _tag: "invalid" });
    expect(migrateEditDocument("not an edit")).toEqual({ _tag: "invalid" });
  });

  it("passes a current document through untouched", () => {
    const current = read(`${FIXTURES}04-engine-b.json`);
    expect(migrateEditDocument(current)).toEqual({
      _tag: "current",
      document: current,
      migratedFrom: null,
    });
  });

  it("chains one step per version and stops at a missing step", () => {
    const steps = {
      1: (document: Record<string, unknown>) => ({ ...document, a: true }),
      2: (document: Record<string, unknown>) => ({ ...document, b: document.a }),
    };
    expect(migrateEditDocument({ version: 1 }, steps, 3)).toEqual({
      _tag: "current",
      document: { version: 3, a: true, b: true },
      migratedFrom: 1,
    });
    expect(migrateEditDocument({ version: 1 }, { 1: steps[1] }, 3)).toEqual({ _tag: "invalid" });
  });

  // Each migration ships a pair: `<from>-<name>.json` and `<from>-<name>.expected.json`.
  it("migrates every fixture pair to its expected current document", () => {
    const pairs = NodeFS.existsSync(MIGRATIONS)
      ? NodeFS.readdirSync(MIGRATIONS).filter((file) => /^\d+-.*(?<!\.expected)\.json$/.test(file))
      : [];
    expect(Object.keys(EDIT_MIGRATIONS)).toHaveLength(EDIT_DOCUMENT_VERSION - 1);
    for (const file of pairs) {
      const migrated = migrateEditDocument(read(`${MIGRATIONS}${file}`));
      const expected = read(`${MIGRATIONS}${file.replace(/\.json$/, ".expected.json")}`);
      expect(migrated, file).toMatchObject({ _tag: "current", document: expected });
      expect(validateEditDocument(expected).ok, file).toBe(true);
    }
  });
});
