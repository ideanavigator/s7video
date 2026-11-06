#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-file generator; no Effect runtime.
// `pnpm edit:schema` writes the edit.json JSON Schema for the engine; `-- --check` fails when it is stale.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { EditDocument } from "@t3tools/contracts";

export const EDIT_SCHEMA_PATH = NodePath.resolve(
  import.meta.dirname,
  "../packages/engine/schema/edit.schema.json",
);

export function renderEditSchema(): string {
  const document = Schema.toJsonSchemaDocument(EditDocument, { onExcessProperty: "error" });
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "edit.schema.json",
    title: "edit.json v1",
    description:
      "Generated from packages/contracts/src/edit.ts by `pnpm edit:schema`. Do not edit by hand.",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const rendered = renderEditSchema();
  const current = NodeFS.existsSync(EDIT_SCHEMA_PATH)
    ? NodeFS.readFileSync(EDIT_SCHEMA_PATH, "utf8")
    : null;
  if (check) {
    if (current !== rendered) {
      console.error(
        `${NodePath.relative(process.cwd(), EDIT_SCHEMA_PATH)} is out of date. Run \`pnpm edit:schema\`.`,
      );
      process.exit(1);
    }
    console.log("edit.schema.json is up to date.");
  } else {
    NodeFS.mkdirSync(NodePath.dirname(EDIT_SCHEMA_PATH), { recursive: true });
    NodeFS.writeFileSync(EDIT_SCHEMA_PATH, rendered);
    console.log(`Wrote ${NodePath.relative(process.cwd(), EDIT_SCHEMA_PATH)}.`);
  }
}
