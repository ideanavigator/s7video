// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";

import { caseNameOf, combineExitCodes, planGoldens, pythonGoldenFile } from "./test-golden.ts";

const TRACKED = [
  "apps/desktop/src/ipc/methods/heic-to-jpeg.golden.test.ts",
  "packages/engine/tests/golden/engine_ping_media_golden.py",
  "packages/engine/tests/golden/test_harness.py",
];

describe("test-golden", () => {
  it("test-golden maps kebab case to python file", () => {
    expect(pythonGoldenFile("engine-ping-media")).toBe("engine_ping_media_golden.py");
    expect(caseNameOf("packages/engine/tests/golden/engine_ping_media_golden.py")).toBe(
      "engine-ping-media",
    );
    expect(caseNameOf("a/heic-to-jpeg.golden.test.ts")).toBe("heic-to-jpeg");
  });

  it("runs every TypeScript and Python golden when no case is named", () => {
    expect(planGoldens(TRACKED, [])).toEqual({
      typescript: [TRACKED[0]],
      python: [TRACKED[1]],
      unknownCases: [],
    });
  });

  it("runs only the named case, and reports unknown ones", () => {
    expect(planGoldens(TRACKED, ["engine-ping-media"])).toEqual({
      typescript: [],
      python: [TRACKED[1]],
      unknownCases: [],
    });
    expect(planGoldens(TRACKED, ["heic-to-jpeg", "nope"]).unknownCases).toEqual(["nope"]);
  });

  it("fails the run when any step fails or could not start", () => {
    expect(combineExitCodes([0, 0])).toBe(0);
    expect(combineExitCodes([0, 1])).toBe(1);
    expect(combineExitCodes([null, 0])).toBe(1);
  });
});
