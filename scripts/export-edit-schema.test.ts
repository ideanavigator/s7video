// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Compares the committed schema file byte for byte.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { EDIT_SCHEMA_PATH, renderEditSchema } from "./export-edit-schema.ts";

describe("edit.json JSON Schema export", () => {
  it("is committed up to date with packages/contracts/src/edit.ts", () => {
    expect(NodeFS.readFileSync(EDIT_SCHEMA_PATH, "utf8")).toBe(renderEditSchema());
  });

  it("rejects unknown properties and float frames, as the TS decoder does", () => {
    const schema = JSON.parse(renderEditSchema());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.version).toMatchObject({ enum: [1] });
    const videoItem = schema.properties.tracks.items.anyOf[0].properties.items.items;
    expect(videoItem.properties.start.type).toBe("integer");
    expect(videoItem.additionalProperties).toBe(false);
  });
});
