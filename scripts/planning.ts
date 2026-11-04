// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small synchronous CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Runs the planning repo's ticket scripts from this checkout. The scripts live in
 * s7video-planning and need cwd = this repo so they can read git history, the
 * changelog and test commands here (see its scripts/app-root.ts).
 */
export const PLANNING_COMMANDS = {
  tickets: "ticket-board.ts",
  "ticket:new": "ticket-create.ts",
  "ticket:validate": "ticket-validate.ts",
  "ticket:verify": "ticket-verify.ts",
  "ticket:finalize": "ticket-finalize.ts",
  "doc:new": "doc-create.ts",
} as const;

type PlanningCommand = keyof typeof PLANNING_COMMANDS;

export const APP_ROOT = NodePath.resolve(import.meta.dirname, "..");

export class PlanningDirError extends Error {}

/** `S7V_PLANNING_DIR` if set (relative to this repo), else the sibling `../s7video-planning`. */
export function resolvePlanningDir(
  env: Readonly<Record<string, string | undefined>>,
  appRoot: string,
): string {
  const fromEnv = env.S7V_PLANNING_DIR?.trim();
  const candidate = fromEnv
    ? NodePath.resolve(appRoot, fromEnv)
    : NodePath.resolve(appRoot, "../s7video-planning");
  if (NodeFS.existsSync(NodePath.join(candidate, "scripts", PLANNING_COMMANDS.tickets))) {
    return candidate;
  }
  const source = fromEnv ? `S7V_PLANNING_DIR=${fromEnv}` : "the default ../s7video-planning";
  throw new PlanningDirError(
    [
      `Planning repo not found at ${candidate} (from ${source}).`,
      "",
      "The ticket scripts live in the s7video-planning repo. Clone it beside this checkout:",
      `  git clone https://github.com/ideanavigator/s7video-planning.git ${NodePath.resolve(appRoot, "../s7video-planning")}`,
      "",
      "or point S7V_PLANNING_DIR at an existing clone:",
      "  S7V_PLANNING_DIR=/path/to/s7video-planning pnpm tickets",
    ].join("\n"),
  );
}

function isPlanningCommand(name: string | undefined): name is PlanningCommand {
  return name !== undefined && Object.hasOwn(PLANNING_COMMANDS, name);
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (!isPlanningCommand(command)) {
    console.error(
      `Usage: node scripts/planning.ts <${Object.keys(PLANNING_COMMANDS).join("|")}> [args...]`,
    );
    return 1;
  }
  let planningDir: string;
  try {
    planningDir = resolvePlanningDir(process.env, APP_ROOT);
  } catch (error) {
    if (error instanceof PlanningDirError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  // pnpm forwards a literal "--" separator; the planning scripts do not expect it.
  const args = rest[0] === "--" ? rest.slice(1) : rest;
  const script = NodePath.join(planningDir, "scripts", PLANNING_COMMANDS[command]);
  const result = NodeChildProcess.spawnSync("bun", ["run", script, ...args], {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`Could not run Bun (${result.error.message}). Install it from https://bun.sh.`);
    return 1;
  }
  return result.status ?? 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
