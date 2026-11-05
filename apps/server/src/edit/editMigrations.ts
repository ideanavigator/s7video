// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { EDIT_DOCUMENT_VERSION } from "@t3tools/contracts";

/** Turns a parsed document at version N into one at version N + 1. */
export type EditMigration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * Every format change adds `[N]: migrate N to N + 1` here, plus a fixture pair under
 * `fixtures/edit-documents/migrations/` (ADR-005). v1 is the first version, so there are none yet.
 */
export const EDIT_MIGRATIONS: Readonly<Record<number, EditMigration>> = {};

export type EditMigrationResult =
  | {
      readonly _tag: "current";
      readonly document: Record<string, unknown>;
      readonly migratedFrom: number | null;
    }
  | { readonly _tag: "future"; readonly version: number }
  | { readonly _tag: "invalid" };

/** Brings a parsed document up to `target`; it never guesses at a version it does not know. */
export function migrateEditDocument(
  raw: unknown,
  migrations: Readonly<Record<number, EditMigration>> = EDIT_MIGRATIONS,
  target: number = EDIT_DOCUMENT_VERSION,
): EditMigrationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { _tag: "invalid" };
  const start = (raw as Record<string, unknown>).version;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 1) {
    return { _tag: "invalid" };
  }
  if (start > target) return { _tag: "future", version: start };
  let document = raw as Record<string, unknown>;
  for (let version = start; version < target; version++) {
    const migrate = migrations[version];
    if (migrate === undefined) return { _tag: "invalid" };
    document = { ...migrate(document), version: version + 1 };
  }
  return { _tag: "current", document, migratedFrom: start === target ? null : start };
}
