// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// Builds the video engine's runtime for the packaged app (S7V-112), and checks a packaged app:
//   node scripts/build-engine-runtime.ts --out DIR [--verbose]
//   node scripts/build-engine-runtime.ts --check-app path/to/App.app
// DIR/python is python-build-standalone CPython with the engine's locked runtime wheels for the
// lock's minimum macOS; DIR/engine is the engine source, schema, fonts and locks. The Python part
// is cached by a hash of its inputs in $S7VIDEO_ENGINE_RUNTIME_BUILD_DIR (default
// ~/Library/Caches/s7video-engine-runtime). Needs uv and network at build time, never at run time.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  checkMachOFiles,
  checkPythonJsonLicences,
  isMachO,
  parseOtoolLoadCommands,
  parseRuntimeLock,
  RUNTIME_LOCK_PATH,
  type MachOFile,
  type PythonJson,
  type RuntimeArchive,
  type RuntimeLock,
} from "./lib/engine-runtime.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const ENGINE_PROJECT = "packages/engine";
const PYTHON_EXECUTABLE = "bin/python3.12";
const SITE_PACKAGES = "lib/python3.12/site-packages";
const KEPT_BIN = new Set(["python3.12", "python3", "python"]);
/** From site-packages to `<Resources>/engine/src`: the engine source sits beside the runtime. */
const ENGINE_SRC_PTH = "../../../../engine/src";
const ENGINE_FILES = ["src", "schema", "assets", "models.lock.json", "uv.lock", "pyproject.toml"];
const USER_AGENT = "s7video-build/1.0 (+https://github.com/ideanavigator/s7video)";

let verbose = false;

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): string {
  if (verbose) console.log(`$ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-20).join("\n");
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}\n${tail}`);
  }
  return result.stdout;
}

const sha256File = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** Fails when the file's sha256 or size differs from the lock: a changed archive never ships. */
export function verifyArchive(file: string, archive: RuntimeArchive): void {
  const size = NodeFS.statSync(file).size;
  const actual = sha256File(file);
  if (actual !== archive.sha256 || size !== archive.size) {
    throw new Error(
      `${NodePath.basename(file)}: sha256 ${actual} (${String(size)} bytes), but ${RUNTIME_LOCK_PATH} pins ${archive.sha256} (${String(archive.size)} bytes)`,
    );
  }
}

function download(archive: RuntimeArchive, folder: string): string {
  const file = NodePath.join(
    folder,
    decodeURIComponent(NodePath.basename(new URL(archive.url).pathname)),
  );
  if (NodeFS.existsSync(file)) {
    try {
      verifyArchive(file, archive);
      return file;
    } catch {
      NodeFS.rmSync(file);
    }
  }
  NodeFS.mkdirSync(folder, { recursive: true });
  console.log(`build-engine-runtime: downloading ${archive.url}`);
  const partial = `${file}.partial`;
  run("/usr/bin/curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--user-agent",
    USER_AGENT,
    "--output",
    partial,
    archive.url,
  ]);
  try {
    verifyArchive(partial, archive);
  } catch (error) {
    NodeFS.rmSync(partial);
    throw error;
  }
  NodeFS.renameSync(partial, file);
  return file;
}

function trim(pythonDir: string, lock: RuntimeLock): void {
  for (const entry of lock.trim) {
    NodeFS.rmSync(NodePath.join(pythonDir, entry), { recursive: true, force: true });
  }
  for (const glob of lock.trimGlobs) {
    const folder = NodePath.join(pythonDir, NodePath.dirname(glob));
    const [prefix, suffix] = NodePath.basename(glob).split("*") as [string, string];
    for (const name of NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder) : []) {
      if (name.startsWith(prefix) && name.endsWith(suffix ?? "")) {
        NodeFS.rmSync(NodePath.join(folder, name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * `.pyc` files that Python uses without checking the source's timestamp: the bundle is read only.
 * `-s` strips the build folder from the paths they record (Python fixes them up at import anyway),
 * so no build-machine path, with its user name, ships in the app.
 */
function compileBytecode(python: string, folder: string, buildRoot: string): void {
  const output = run(
    python,
    [
      "-I",
      "-m",
      "compileall",
      "-q",
      "-f",
      "-j0",
      "--invalidation-mode",
      "unchecked-hash",
      "-s",
      buildRoot,
      folder,
    ],
    { allowFailure: true },
  );
  const failed = output.split("\n").filter((line) => line.startsWith("*** Error compiling")).length;
  if (failed > 0) {
    console.log(
      `build-engine-runtime: ${String(failed)} file(s) in ${folder} are not valid Python 3.12; they stay source only`,
    );
  }
}

function walkFiles(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of NodeFS.readdirSync(NodePath.join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Files under `root` whose bytes contain `text`: a build path would ship the builder's user name. */
function filesContaining(root: string, text: string): string[] {
  const needle = Buffer.from(text);
  return walkFiles(root).filter((path) =>
    NodeFS.readFileSync(NodePath.join(root, path)).includes(needle),
  );
}

/** Every Mach-O under `root`, with its arm64 load commands. */
export function scanMachOFiles(root: string): MachOFile[] {
  const files: MachOFile[] = [];
  const header = new Uint8Array(8);
  // otool reads `name(member)` as an archive member, and Electron's helpers are "… Helper (GPU)".
  const links = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-otool-"));
  try {
    for (const path of walkFiles(root)) {
      const absolute = NodePath.join(root, path);
      const fd = NodeFS.openSync(absolute, "r");
      const read = NodeFS.readSync(fd, header, 0, 8, 0);
      NodeFS.closeSync(fd);
      if (read < 8 || !isMachO(header)) continue;
      let target = absolute;
      if (absolute.endsWith(")")) {
        target = NodePath.join(links, String(files.length));
        NodeFS.symlinkSync(absolute, target);
      }
      const output = run("/usr/bin/otool", ["-arch", "arm64", "-l", target]);
      files.push({ path, commands: parseOtoolLoadCommands(output) });
    }
  } finally {
    NodeFS.rmSync(links, { recursive: true, force: true });
  }
  return files;
}

function inputsKey(lock: RuntimeLock): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [
    RUNTIME_LOCK_PATH,
    `${ENGINE_PROJECT}/uv.lock`,
    "scripts/build-engine-runtime.ts",
    "scripts/lib/engine-runtime.ts",
  ]) {
    hash.update(NodeFS.readFileSync(NodePath.join(REPO_ROOT, file)));
  }
  hash.update(lock.macosMinimum);
  return hash.digest("hex").slice(0, 16);
}

function buildPython(lock: RuntimeLock, archive: string, licenceArchive: string, workDir: string) {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
  NodeFS.mkdirSync(workDir, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archive, "-C", workDir]);
  const full = NodePath.join(workDir, "full");
  NodeFS.mkdirSync(full);
  run("/usr/bin/tar", [
    "--zstd",
    "-xf",
    licenceArchive,
    "-C",
    full,
    "python/PYTHON.json",
    "python/licenses",
  ]);
  const pythonDir = NodePath.join(workDir, "python");
  const python = NodePath.join(pythonDir, PYTHON_EXECUTABLE);
  trim(pythonDir, lock);

  const licencesDir = NodePath.join(pythonDir, "licenses");
  NodeFS.mkdirSync(licencesDir, { recursive: true });
  for (const component of lock.components.filter((entry) => entry.shipped)) {
    for (const name of component.licenceFiles) {
      NodeFS.copyFileSync(
        NodePath.join(full, "python/licenses", name),
        NodePath.join(licencesDir, name),
      );
    }
  }

  const requirements = NodePath.join(workDir, "requirements.txt");
  run("uv", [
    "export",
    "--frozen",
    "--no-dev",
    "--no-emit-project",
    "--no-header",
    "--quiet",
    "--project",
    ENGINE_PROJECT,
    "--format",
    "requirements-txt",
    "--output-file",
    requirements,
  ]);
  // The deployment target picks wheels that run on the minimum macOS, not on the build Mac's.
  run(
    "uv",
    [
      "pip",
      "install",
      "--no-config",
      "--quiet",
      "--python",
      python,
      "--break-system-packages",
      "--require-hashes",
      "--no-deps",
      "--no-build",
      "--python-platform",
      lock.python.triple,
      "--python-version",
      lock.python.version.split(".").slice(0, 2).join("."),
      "--requirements",
      requirements,
    ],
    { env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: lock.macosMinimum } },
  );
  NodeFS.writeFileSync(
    NodePath.join(pythonDir, SITE_PACKAGES, "s7engine-src.pth"),
    `${ENGINE_SRC_PTH}\n`,
  );
  // uv writes console-script launchers whose shebang names this build folder; the engine needs none.
  const binDir = NodePath.join(pythonDir, "bin");
  for (const name of NodeFS.readdirSync(binDir)) {
    if (!KEPT_BIN.has(name)) NodeFS.rmSync(NodePath.join(binDir, name), { force: true });
  }

  const facts = JSON.parse(
    run(python, [
      "-I",
      "-c",
      "import json, ssl, sys; print(json.dumps({'openssl': ssl.OPENSSL_VERSION, 'builtins': sorted(sys.builtin_module_names)}))",
    ]),
  ) as { openssl: string; builtins: string[] };
  if (!facts.openssl.startsWith("OpenSSL 3.")) {
    throw new Error(`the runtime links ${facts.openssl}; the lock's OpenSSL component expects 3.x`);
  }
  const dynload = NodeFS.readdirSync(NodePath.join(pythonDir, "lib/python3.12/lib-dynload"));
  const shipped = new Set([...facts.builtins, ...dynload.map((name) => name.split(".")[0]!)]);
  const pythonJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(full, "python/PYTHON.json"), "utf8"),
  ) as PythonJson;
  const licenceProblems = checkPythonJsonLicences(pythonJson, lock, shipped);
  if (licenceProblems.length > 0) throw new Error(licenceProblems.join("\n"));

  compileBytecode(python, NodePath.join(pythonDir, "lib/python3.12"), workDir);
  NodeFS.rmSync(full, { recursive: true, force: true });
  NodeFS.rmSync(requirements);
}

function stageEngine(python: string, engineDir: string): void {
  NodeFS.rmSync(engineDir, { recursive: true, force: true });
  const tracked = run("git", [
    "ls-files",
    "-z",
    "--",
    ...ENGINE_FILES.map((entry) => `${ENGINE_PROJECT}/${entry}`),
  ])
    .split("\0")
    .filter(Boolean);
  for (const file of tracked) {
    const target = NodePath.join(engineDir, file.slice(ENGINE_PROJECT.length + 1));
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(REPO_ROOT, file), target);
  }
  compileBytecode(python, NodePath.join(engineDir, "src"), NodePath.dirname(engineDir));
}

/** The staged runtime imports what the engine needs, from a folder it was never built in. */
function smokeTest(outDir: string): void {
  const output = run(
    NodePath.join(outDir, "python", PYTHON_EXECUTABLE),
    [
      "-I",
      "-B",
      "-c",
      "import mlx.core as mx, mlx_audio, numpy, scipy, opentimelineio, Vision, Quartz, s7engine, s7engine.models as m, s7engine.edit_schema as e; print(mx.default_device(), m.LOCK_PATH.is_file(), e.SCHEMA_PATH.is_file(), s7engine.__file__, sep='|')",
    ],
    { cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: NodeOS.tmpdir() } },
  );
  const [device, lockFound, schemaFound, source] = output.trim().split("|");
  const expectedSource = NodePath.join(outDir, "engine/src/s7engine/__init__.py");
  if (
    !device?.includes("gpu") ||
    lockFound !== "True" ||
    schemaFound !== "True" ||
    NodeFS.realpathSync(source ?? "/") !== NodeFS.realpathSync(expectedSource)
  ) {
    throw new Error(`the staged runtime failed its import check: ${output.trim()}`);
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Runs `body` holding `<cacheRoot>/.lock`, a `mkdir` lock like the heavy-run slots: the cache is
 * shared by every worktree on the Mac, and a build or prune must not delete another's folders. A
 * lock whose owner process is gone is taken over.
 */
export function withCacheLock<A>(
  cacheRoot: string,
  body: () => A,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): A {
  const lockDir = NodePath.join(cacheRoot, ".lock");
  const owner = NodePath.join(lockDir, "owner");
  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60 * 1000);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  NodeFS.mkdirSync(cacheRoot, { recursive: true });
  for (;;) {
    try {
      NodeFS.mkdirSync(lockDir);
      NodeFS.writeFileSync(owner, `${String(process.pid)}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number.parseInt(
      NodeFS.existsSync(owner) ? NodeFS.readFileSync(owner, "utf8") : "",
      10,
    );
    if (Number.isInteger(holder) && !isAlive(holder)) {
      NodeFS.rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${lockDir} is held by PID ${String(holder)}; another build is using the cache`,
      );
    }
    Atomics.wait(wait, 0, 0, options.pollMs ?? 2000);
  }
  try {
    return body();
  } finally {
    NodeFS.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Downloads, builds (or reuses) and prunes the cached runtime, then clones it to `pythonOut`. */
function stageCachedPython(lock: RuntimeLock, cacheRoot: string, pythonOut: string): void {
  const downloads = NodePath.join(cacheRoot, "downloads");
  const archive = download(lock.python.archive, downloads);
  const licenceArchive = download(lock.python.licenceArchive, downloads);
  const key = inputsKey(lock);
  const cached = NodePath.join(cacheRoot, `runtime-${key}`);
  if (NodeFS.existsSync(NodePath.join(cached, ".complete"))) {
    console.log(`build-engine-runtime: reusing the cached runtime (${key})`);
  } else {
    console.log(
      `build-engine-runtime: building the runtime (${key}) for macOS ${lock.macosMinimum}`,
    );
    const work = NodePath.join(cacheRoot, `work-${key}`);
    buildPython(lock, archive, licenceArchive, work);
    NodeFS.rmSync(cached, { recursive: true, force: true });
    NodeFS.renameSync(work, cached);
    NodeFS.writeFileSync(NodePath.join(cached, ".complete"), `${key}\n`);
    // One cached runtime is about 600 MB; older ones are never reused.
    for (const entry of NodeFS.readdirSync(cacheRoot)) {
      if (/^(runtime|work)-[0-9a-f]{16}$/u.test(entry) && entry !== `runtime-${key}`) {
        NodeFS.rmSync(NodePath.join(cacheRoot, entry), { recursive: true, force: true });
      }
    }
  }

  NodeFS.mkdirSync(NodePath.dirname(pythonOut), { recursive: true });
  NodeFS.rmSync(pythonOut, { recursive: true, force: true });
  // APFS clone: 550 MB staged in a second, sharing blocks with the cache.
  run("/bin/cp", ["-cR", NodePath.join(cached, "python"), pythonOut]);
}

export function buildEngineRuntime(outDir: string): void {
  const lock = parseRuntimeLock(
    JSON.parse(NodeFS.readFileSync(NodePath.join(REPO_ROOT, RUNTIME_LOCK_PATH), "utf8")),
  );
  const cacheRoot =
    process.env.S7VIDEO_ENGINE_RUNTIME_BUILD_DIR ??
    NodePath.join(NodeOS.homedir(), "Library/Caches/s7video-engine-runtime");
  const pythonOut = NodePath.join(outDir, "python");
  withCacheLock(cacheRoot, () => stageCachedPython(lock, cacheRoot, pythonOut));
  stageEngine(NodePath.join(pythonOut, PYTHON_EXECUTABLE), NodePath.join(outDir, "engine"));

  const machO = scanMachOFiles(outDir);
  const problems = checkMachOFiles({
    files: machO,
    macosMinimum: lock.macosMinimum,
    executable: `python/${PYTHON_EXECUTABLE}`,
    exists: (relative) => NodeFS.existsSync(NodePath.join(outDir, relative)),
    resolveInside: true,
  });
  if (problems.length > 0) {
    throw new Error(
      `the engine runtime would not run on macOS ${lock.macosMinimum} without other software:\n${problems.join("\n")}`,
    );
  }
  const leaks = filesContaining(outDir, NodeOS.homedir());
  if (leaks.length > 0) {
    throw new Error(
      `these files name the build Mac's home folder: ${leaks.slice(0, 5).join(", ")}`,
    );
  }
  smokeTest(outDir);
  console.log(
    `build-engine-runtime: ${String(machO.length)} Mach-O files, all for macOS ${lock.macosMinimum} or older, linking only the runtime, /usr/lib and /System; staged in ${outDir}`,
  );
}

/**
 * Checks a packaged app (S7V-112 AC-2, and the sprint's "no Homebrew or Xcode at run time"): every
 * Mach-O needs the lock's minimum macOS or older and links only inside the app, /usr/lib and
 * /System; the runtime's own links resolve inside Resources; Info.plist asks for the same minimum;
 * the `.pyc` files survived packaging; and the runtime imports the engine from inside the app.
 */
export function checkPackagedApp(appPath: string): void {
  const lock = parseRuntimeLock(
    JSON.parse(NodeFS.readFileSync(NodePath.join(REPO_ROOT, RUNTIME_LOCK_PATH), "utf8")),
  );
  const resources = NodePath.join(appPath, "Contents/Resources");
  const problems: string[] = [];
  const minimum = run(
    "/usr/bin/plutil",
    [
      "-extract",
      "LSMinimumSystemVersion",
      "raw",
      "-o",
      "-",
      NodePath.join(appPath, "Contents/Info.plist"),
    ],
    { allowFailure: true },
  ).trim();
  if (minimum !== lock.macosMinimum) {
    problems.push(`Info.plist LSMinimumSystemVersion is "${minimum}", not ${lock.macosMinimum}`);
  }
  for (const required of [
    `python/${PYTHON_EXECUTABLE}`,
    "engine/src/s7engine/__main__.py",
    "engine/pyproject.toml",
  ]) {
    if (!NodeFS.existsSync(NodePath.join(resources, required)))
      problems.push(`Resources/${required} is missing`);
  }
  if (!NodeFS.existsSync(NodePath.join(resources, "engine/src/s7engine/__pycache__"))) {
    problems.push(
      "Resources/engine/src/s7engine has no __pycache__: packaging dropped the compiled .pyc files",
    );
  }
  const files = scanMachOFiles(appPath);
  const runtimePrefix = "Contents/Resources/";
  const inRuntime = (file: MachOFile) =>
    file.path.startsWith(`${runtimePrefix}python/`) ||
    file.path.startsWith(`${runtimePrefix}engine/`);
  problems.push(
    ...checkMachOFiles({
      files: files.filter((file) => !inRuntime(file)),
      macosMinimum: lock.macosMinimum,
      exists: () => true,
      resolveInside: false,
    }),
    ...checkMachOFiles({
      files: files
        .filter(inRuntime)
        .map((file) => ({ ...file, path: file.path.slice(runtimePrefix.length) })),
      macosMinimum: lock.macosMinimum,
      executable: `python/${PYTHON_EXECUTABLE}`,
      exists: (relative) => NodeFS.existsSync(NodePath.join(resources, relative)),
      resolveInside: true,
    }),
  );
  if (problems.length > 0)
    throw new Error(`the packaged app fails its runtime checks:\n${problems.join("\n")}`);
  smokeTest(resources);
  console.log(
    `build-engine-runtime: ${String(files.length)} Mach-O files in ${NodePath.basename(appPath)}, all for macOS ${lock.macosMinimum} or older, linking only the app, /usr/lib and /System`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  verbose = args.includes("--verbose");
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const out = valueOf("--out");
  const app = valueOf("--check-app");
  if ((out === undefined) === (app === undefined)) {
    console.error(
      "usage: node scripts/build-engine-runtime.ts (--out DIR | --check-app APP) [--verbose]",
    );
    process.exitCode = 2;
  } else {
    try {
      if (out !== undefined) buildEngineRuntime(NodePath.resolve(out));
      else checkPackagedApp(NodePath.resolve(app!));
    } catch (error) {
      console.error(
        `build-engine-runtime: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
