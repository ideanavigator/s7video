// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs golden media tests: `pnpm test:golden` for all, `pnpm test:golden -- <case>` for one.
// TypeScript cases are `<case>.golden.test.ts` (run with `vp test run`); Python engine cases are
// `packages/engine/tests/golden/<case_name>_golden.py` (run with uv and pytest). Before Python
// cases run, the test clips are fetched or reused (`pnpm media:fetch`); `--no-fetch` skips that.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { fetchTestMedia } from "./fetch-test-media.ts";

const ENGINE_PROJECT = "packages/engine";
const PYTHON_GOLDEN_DIR = `${ENGINE_PROJECT}/tests/golden`;

/** `engine-ping-media` → `engine_ping_media_golden.py`. */
export function pythonGoldenFile(caseName: string): string {
  return `${caseName.replaceAll("-", "_")}_golden.py`;
}

/** `engine_ping_media_golden.py` → `engine-ping-media`; `heic-to-jpeg.golden.test.ts` → `heic-to-jpeg`. */
export function caseNameOf(file: string): string {
  const base = NodePath.basename(file);
  if (base.endsWith(".golden.test.ts")) return base.slice(0, -".golden.test.ts".length);
  return base.slice(0, -"_golden.py".length).replaceAll("_", "-");
}

export interface GoldenPlan {
  readonly typescript: ReadonlyArray<string>;
  readonly python: ReadonlyArray<string>;
  readonly unknownCases: ReadonlyArray<string>;
}

/** Which golden files to run for the requested cases (all of them when none is named). */
export function planGoldens(
  tracked: ReadonlyArray<string>,
  cases: ReadonlyArray<string>,
): GoldenPlan {
  const typescript = tracked.filter((file) => file.endsWith(".golden.test.ts"));
  const python = tracked.filter(
    (file) => file.startsWith(`${PYTHON_GOLDEN_DIR}/`) && file.endsWith("_golden.py"),
  );
  const wanted = (file: string) => cases.length === 0 || cases.includes(caseNameOf(file));
  const known = new Set([...typescript, ...python].map(caseNameOf));
  return {
    typescript: typescript.filter(wanted),
    python: python.filter(wanted),
    unknownCases: cases.filter((name) => !known.has(name)),
  };
}

/** One failing step fails the run; a step that could not start counts as failing. */
export function combineExitCodes(codes: ReadonlyArray<number | null>): number {
  return codes.some((code) => code !== 0) ? 1 : 0;
}

function run(command: string, args: ReadonlyArray<string>, root: string): number | null {
  const result = NodeChildProcess.spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) console.error(`test:golden: could not run ${command}: ${result.error.message}`);
  return result.error ? 1 : result.status;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const args = argv.filter((arg) => arg !== "--");
  const fetch = !args.includes("--no-fetch");
  const cases = args.filter((arg) => !arg.startsWith("--"));
  const tracked = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "*.golden.test.ts", `${PYTHON_GOLDEN_DIR}/*_golden.py`],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const plan = planGoldens(tracked, cases);
  if (plan.unknownCases.length > 0 || plan.typescript.length + plan.python.length === 0) {
    console.error(`No golden test matches ${plan.unknownCases.join(", ") || "any golden file"}.`);
    return 1;
  }
  const codes: Array<number | null> = [];
  if (plan.typescript.length > 0) codes.push(run("vp", ["test", "run", ...plan.typescript], root));
  if (plan.python.length > 0) {
    if (fetch) codes.push((await fetchTestMedia()) > 0 ? 1 : 0);
    codes.push(
      run(
        "uv",
        ["run", "--frozen", "--project", ENGINE_PROJECT, "pytest", "-ra", ...plan.python],
        root,
      ),
    );
  }
  return combineExitCodes(codes);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
