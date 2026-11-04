// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs golden media tests: `pnpm test:golden` for all, `pnpm test:golden -- <case>` for one.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const cases = process.argv.slice(2).filter((arg) => arg !== "--");
const files = NodeChildProcess.execFileSync("git", ["ls-files", "*.golden.test.ts"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((file) => {
    const name = NodePath.basename(file, ".golden.test.ts");
    return cases.length === 0 || cases.includes(name);
  });

if (files.length === 0) {
  console.error(`No golden test matches ${cases.join(", ") || "*.golden.test.ts"}.`);
  process.exit(1);
}
const run = NodeChildProcess.spawnSync("vp", ["test", "run", ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
