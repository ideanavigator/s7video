// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off globalDate:off
// Packaged engine smoke (S7V-112 Tier 3, no Electron harness yet):
//   node scripts/smoke-packaged-engine.ts --app "release/mac-arm64/<name>.app" [--ffmpeg-dir DIR] [--keep]
// Copies the app to a scratch folder with read-only Python and engine resources, starts it with a
// temp HOME, S7VIDEO_HOME and a system-only PATH (`env -i`), asks its server for
// `transcribe.models.status` over the WebSocket RPC (which starts the engine), then checks the engine
// log names the bundled Python, nothing was written inside the app, and the temp home holds no
// Hugging Face cache. Without `--ffmpeg-dir` it expects the "reinstall" error until the app ships
// FFmpeg (S7V-016); with it, the folder's ffmpeg and ffprobe stand in for the bundled ones.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

interface Snapshot {
  readonly [path: string]: string;
}

function snapshot(root: string, relative = ""): Snapshot {
  const out: Record<string, string> = {};
  for (const entry of NodeFS.readdirSync(NodePath.join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, snapshot(root, path));
    else {
      const info = NodeFS.lstatSync(NodePath.join(root, path));
      out[path] = `${String(info.size)}:${String(info.mtimeMs)}`;
    }
  }
  return out;
}

function descendants(pid: number): number[] {
  const children = NodeChildProcess.spawnSync("/usr/bin/pgrep", ["-P", String(pid)], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
  return [...children, ...children.flatMap(descendants)];
}

function listeningPort(pid: number): number | undefined {
  const pids = [pid, ...descendants(pid)].join(",");
  const output = NodeChildProcess.spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", pids, "-iTCP", "-sTCP:LISTEN", "-Fn"],
    { encoding: "utf8" },
  ).stdout;
  const match = /^n127\.0\.0\.1:(\d+)$/mu.exec(output) ?? /^n\*:(\d+)$/mu.exec(output);
  return match ? Number(match[1]) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const modelsStatus = Effect.fn("smokePackagedEngine.modelsStatus")(function* (url: string) {
  return yield* Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    return yield* client["transcribe.models.status"]({});
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(NodeSocket.layerWebSocket(url)),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
    Effect.timeout("90 seconds"),
  );
});

async function main(args: ReadonlyArray<string>): Promise<number> {
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const app = valueOf("--app");
  const ffmpegDir = valueOf("--ffmpeg-dir");
  if (app === undefined) {
    console.error(
      'usage: node scripts/smoke-packaged-engine.ts --app "<name>.app" [--ffmpeg-dir DIR] [--keep]',
    );
    return 2;
  }
  const scratch = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7v-engine-smoke-")),
  );
  const copy = NodePath.join(scratch, NodePath.basename(app));
  const home = NodePath.join(scratch, "home");
  const dataHome = NodePath.join(home, ".s7video");
  const resources = NodePath.join(copy, "Contents/Resources");
  const readOnly = [NodePath.join(resources, "python"), NodePath.join(resources, "engine")];
  NodeFS.mkdirSync(NodePath.join(scratch, "tmp"), { recursive: true });
  NodeFS.mkdirSync(home);
  NodeChildProcess.execFileSync("/bin/cp", ["-cR", NodePath.resolve(app), copy]);
  NodeChildProcess.execFileSync("/bin/chmod", ["-R", "a-w", ...readOnly]);
  const before = snapshot(resources);
  const executable = NodePath.join(
    copy,
    "Contents/MacOS",
    NodeFS.readdirSync(NodePath.join(copy, "Contents/MacOS"))[0]!,
  );
  const env: Record<string, string> = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    S7VIDEO_HOME: dataHome,
    PATH: SYSTEM_PATH,
    TMPDIR: NodePath.join(scratch, "tmp"),
    ...(ffmpegDir
      ? {
          S7VIDEO_FFMPEG: NodePath.join(ffmpegDir, "ffmpeg"),
          S7VIDEO_FFPROBE: NodePath.join(ffmpegDir, "ffprobe"),
        }
      : {}),
  };
  const problems: string[] = [];
  const log = NodeFS.openSync(NodePath.join(scratch, "app.log"), "w");
  const child = NodeChildProcess.spawn(executable, [], { env, stdio: ["ignore", log, log] });
  const pid = child.pid!;
  console.log(`smoke: started ${NodePath.basename(app)} as PID ${String(pid)} with HOME ${home}`);
  try {
    let port: number | undefined;
    for (let attempt = 0; attempt < 180 && port === undefined; attempt += 1) {
      await sleep(500);
      if (child.exitCode !== null) throw new Error(`the app exited with ${String(child.exitCode)}`);
      port = listeningPort(pid);
    }
    if (port === undefined) throw new Error("the app's server never listened");
    console.log(`smoke: server listening on 127.0.0.1:${String(port)}`);

    const backendEntry = NodePath.join(resources, "app.asar/apps/server/dist/bin.mjs");
    const token = NodeChildProcess.execFileSync(
      executable,
      [backendEntry, "auth", "session", "issue", "--base-dir", dataHome, "--token-only"],
      { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
    ).trim();
    const ticketResponse = await fetch(
      `http://127.0.0.1:${String(port)}/api/auth/websocket-ticket/rpc`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );
    if (!ticketResponse.ok)
      throw new Error(`websocket ticket: HTTP ${String(ticketResponse.status)}`);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };

    const startedAt = Date.now();
    const outcome = await Effect.runPromise(
      modelsStatus(`ws://127.0.0.1:${String(port)}/ws?wsTicket=${encodeURIComponent(ticket)}`).pipe(
        Effect.result,
      ),
    );
    const elapsed = Date.now() - startedAt;
    if (outcome._tag === "Success") {
      const ready = Object.entries(outcome.success.profiles ?? {}).map(
        ([name, profile]) => `${name}=${String((profile as { ready: boolean }).ready)}`,
      );
      console.log(
        `smoke: transcribe.models.status answered in ${String(elapsed)} ms (${ready.join(", ")})`,
      );
      if (!ffmpegDir)
        problems.push("the engine started without a bundled FFmpeg; expected the reinstall error");
    } else {
      const message = String((outcome.failure as { message?: string }).message ?? outcome.failure);
      console.log(`smoke: transcribe.models.status failed: ${message}`);
      if (ffmpegDir || !message.includes("ffmpeg that comes with the app is missing")) {
        problems.push(`transcribe.models.status failed: ${message}`);
      }
    }

    const engineLog = NodePath.join(dataHome, "userdata/logs/engine/engine.log");
    if (ffmpegDir) {
      const text = NodeFS.existsSync(engineLog) ? NodeFS.readFileSync(engineLog, "utf8") : "";
      const header = /^--- engine pid (\d+) started \S+: (.+), ffmpeg (.+)$/mu.exec(text);
      const python = NodePath.join(resources, "python/bin/python3.12");
      console.log(`smoke: engine log ${engineLog}: ${header?.[0] ?? "(no start line)"}`);
      if (header?.[2] !== python) problems.push(`the engine log does not name ${python}`);
      const command = header
        ? NodeChildProcess.spawnSync("/bin/ps", ["-o", "command=", "-p", header[1]!], {
            encoding: "utf8",
          }).stdout.trim()
        : "";
      console.log(`smoke: engine process: ${command}`);
      if (command !== `${python} -I -B -m s7engine`)
        problems.push(`engine process is "${command}"`);
      if (text.replace(header?.[3] ?? "", "").includes("/opt/homebrew")) {
        problems.push("the engine log mentions /opt/homebrew");
      }
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    child.kill("SIGTERM");
    for (
      let attempt = 0;
      attempt < 40 && child.exitCode === null && child.signalCode === null;
      attempt += 1
    ) {
      await sleep(250);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    NodeFS.closeSync(log);
    console.log(`smoke: stopped PID ${String(pid)}`);
  }

  const after = snapshot(resources);
  const changed = [
    ...Object.keys(after).filter((path) => before[path] !== after[path]),
    ...Object.keys(before).filter((path) => !(path in after)),
  ];
  if (changed.length > 0)
    problems.push(`files changed inside the app: ${changed.slice(0, 10).join(", ")}`);
  if (NodeFS.existsSync(NodePath.join(home, ".cache/huggingface"))) {
    problems.push("something wrote ~/.cache/huggingface in the temp home");
  }
  console.log(
    `smoke: temp home holds ${NodeFS.readdirSync(home).join(", ")}; ${dataHome}: ${NodeFS.readdirSync(dataHome).join(", ")}`,
  );

  NodeChildProcess.execFileSync("/bin/chmod", ["-R", "u+w", ...readOnly]);
  if (args.includes("--keep")) console.log(`smoke: kept ${scratch}`);
  else NodeFS.rmSync(scratch, { recursive: true, force: true });
  for (const problem of problems) console.error(`smoke: FAIL ${problem}`);
  if (problems.length === 0) console.log("smoke: PASS");
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
