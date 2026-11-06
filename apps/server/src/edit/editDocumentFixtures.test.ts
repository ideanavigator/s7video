// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Reads the shared fixture files the engine also reads.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { validateEditDocument } from "@t3tools/contracts";

const FIXTURES = NodeURL.fileURLToPath(
  new URL("../../../../fixtures/edit-documents/", import.meta.url),
);
interface FixtureCase {
  readonly file: string;
  readonly valid: boolean;
  readonly reason?: string;
  readonly itemId?: string | null;
}
const { cases } = JSON.parse(NodeFS.readFileSync(`${FIXTURES}cases.json`, "utf8")) as {
  readonly cases: ReadonlyArray<FixtureCase>;
};
const load = (file: string): unknown =>
  JSON.parse(NodeFS.readFileSync(`${FIXTURES}${file}`, "utf8"));

describe("edit.json v1 validation", () => {
  // The engine's test_edit_schema.py runs the same cases against the exported JSON Schema.
  it.each(cases)("$file matches the shared expectation", (fixture) => {
    const result = validateEditDocument(load(fixture.file));
    if (fixture.valid) {
      expect(result).toMatchObject({ ok: true });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect({ reason: result.issues[0]!.reason, itemId: result.issues[0]!.itemId }).toEqual({
      reason: fixture.reason,
      itemId: fixture.itemId,
    });
  });

  it("covers at least ten valid and ten invalid documents, including an Engine B edit", () => {
    expect(cases.filter((fixture) => fixture.valid).length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((fixture) => !fixture.valid).length).toBeGreaterThanOrEqual(10);
    const engineB = load("04-engine-b.json") as {
      readonly media: ReadonlyArray<unknown>;
      readonly tracks: ReadonlyArray<{ readonly kind: string }>;
    };
    expect(engineB.media.length).toBeGreaterThanOrEqual(3);
    expect(new Set(engineB.tracks.map((track) => track.kind))).toEqual(
      new Set(["video", "caption", "sfx", "music", "overlay"]),
    );
  });

  it("names the item in plain words for each rejection", () => {
    const messages = cases
      .filter((fixture) => !fixture.valid && fixture.itemId !== null)
      .map((fixture) => {
        const result = validateEditDocument(load(fixture.file));
        return { fixture, explanation: result.ok ? "" : result.issues[0]!.explanation };
      });
    for (const { fixture, explanation } of messages) {
      expect(explanation, fixture.file).toContain(`"${fixture.itemId}"`);
      expect(explanation, fixture.file).not.toMatch(/undefined|\[object/);
    }
  });

  it("should handle 29.97 fps document", () => {
    const result = validateEditDocument(load("05-ntsc-2997.json"));
    expect(result.ok && result.document.fps).toEqual({ num: 30000, den: 1001 });
  });

  it("should reject float frames anywhere a frame is stored", () => {
    const document = load("04-engine-b.json") as {
      tracks: Array<{ items: Array<Record<string, unknown>>; duck?: { attackFrames: number } }>;
    };
    document.tracks[3]!.duck!.attackFrames = 2.5;
    expect(validateEditDocument(document)).toMatchObject({
      ok: false,
      issues: [{ reason: "frame", itemId: "M1" }],
    });
  });
});
