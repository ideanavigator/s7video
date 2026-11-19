// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- Checks the folder and a child's environment directly.
/**
 * S7V-114: on a Mac without the developer tools, the agent CLIs run Apple's `/usr/bin/git` stub
 * themselves (Claude Code's start-up `git ls-files`), which opens the install dialog. The server
 * points DEVELOPER_DIR at an empty folder so the stub fails at once instead.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ServerConfig } from "../config.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import * as AgentDeveloperDir from "./AgentDeveloperDir.ts";
import * as SystemGit from "./SystemGit.ts";

const missing: SystemGit.SystemGitStatus = { available: false, path: null };
const present: SystemGit.SystemGitStatus = {
  available: true,
  path: "/Library/Developer/CommandLineTools/usr/bin/git",
};

const systemGitWith = (
  status: SystemGit.SystemGitStatus,
  changes: Stream.Stream<SystemGit.SystemGitStatus> = Stream.empty,
) =>
  SystemGit.SystemGit.of({
    status: Effect.succeed(status),
    refresh: Effect.succeed(status),
    subscribeChanges: Effect.succeed(changes),
  });

/** Builds the server's layer against `env` and the given git answer, then runs `check`. */
const withAgentDeveloperDir = <A>(
  env: NodeJS.ProcessEnv,
  systemGit: ReturnType<typeof systemGitWith>,
  check: (emptyDir: string) => Effect.Effect<A, never, Path.Path>,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const emptyDir = NodePath.join(config.baseDir, "empty-developer-dir");
    return yield* check(emptyDir).pipe(Effect.provide(AgentDeveloperDir.layer));
  }).pipe(
    Effect.provideService(SystemGit.SystemGit, systemGit),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "s7v114-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("AgentDeveloperDir", () => {
  it.effect("points DEVELOPER_DIR at an empty, owner-only folder without the tools", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    return withAgentDeveloperDir(env, systemGitWith(missing), (emptyDir) =>
      Effect.sync(() => {
        assert.strictEqual(env.DEVELOPER_DIR, emptyDir);
        assert.deepEqual(NodeFS.readdirSync(emptyDir), []);
        assert.strictEqual(NodeFS.statSync(emptyDir).mode & 0o777, 0o700);
        assert.strictEqual(env.PATH, "/usr/bin:/bin");
      }),
    );
  });

  it.effect("replaces a user's DEVELOPER_DIR that holds no tools", () => {
    const env: NodeJS.ProcessEnv = { DEVELOPER_DIR: "/Applications/Gone.app/Contents/Developer" };
    return withAgentDeveloperDir(env, systemGitWith(missing), (emptyDir) =>
      Effect.sync(() => assert.strictEqual(env.DEVELOPER_DIR, emptyDir)),
    );
  });

  it.effect("leaves the environment alone with the tools", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    return withAgentDeveloperDir(env, systemGitWith(present), (emptyDir) =>
      Effect.sync(() => {
        assert.deepEqual(env, { PATH: "/usr/bin:/bin" });
        assert.isFalse(NodeFS.existsSync(emptyDir));
      }),
    );
  });

  it.effect("keeps a user's DEVELOPER_DIR that holds the tools", () => {
    const xcodeBeta = "/Applications/Xcode-beta.app/Contents/Developer";
    const env: NodeJS.ProcessEnv = { DEVELOPER_DIR: xcodeBeta };
    return withAgentDeveloperDir(env, systemGitWith(present), () =>
      Effect.sync(() => assert.deepEqual(env, { DEVELOPER_DIR: xcodeBeta })),
    );
  });

  it.effect(
    "follows the tools being installed and removed in the server's environment, recreating a deleted folder",
    () => {
      const userValue = "/Applications/Gone.app/Contents/Developer";
      const env: NodeJS.ProcessEnv = { DEVELOPER_DIR: userValue };
      const seen: Array<string | undefined> = [];
      return Effect.gen(function* () {
        const drained = yield* Deferred.make<void>();
        let emptyDirSeen = "";
        // Each step records what an agent started now would get, then moves to the next answer.
        const changes = Stream.make(present).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                seen.push(env.DEVELOPER_DIR);
                NodeFS.rmSync(emptyDirSeen, { recursive: true, force: true });
                return missing;
              }),
            ),
          ),
          Stream.concat(Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain)),
        );
        yield* withAgentDeveloperDir(env, systemGitWith(missing, changes), (emptyDir) =>
          Effect.gen(function* () {
            emptyDirSeen = emptyDir;
            yield* Deferred.await(drained);
            assert.deepEqual(seen, [userValue]);
            assert.strictEqual(env.DEVELOPER_DIR, emptyDir);
            assert.deepEqual(NodeFS.readdirSync(emptyDir), []);
          }),
        );
      });
    },
  );

  it.effect("gives copies taken without the tools the user's value once they are installed", () => {
    const xcodeBeta = "/Applications/Xcode-beta.app/Contents/Developer";
    const env: NodeJS.ProcessEnv = { DEVELOPER_DIR: xcodeBeta };
    return Effect.gen(function* () {
      const drained = yield* Deferred.make<void>();
      const changes = Stream.make(present).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain)),
      );
      yield* withAgentDeveloperDir(env, systemGitWith(missing, changes), (emptyDir) =>
        Effect.gen(function* () {
          yield* Deferred.await(drained);
          const { forSpawn } = yield* AgentDeveloperDir.AgentDeveloperDir;
          // A provider instance's copy, taken while the tools were missing.
          const stale = { PATH: "/usr/bin:/bin", DEVELOPER_DIR: emptyDir };
          assert.deepEqual(forSpawn(stale), { PATH: "/usr/bin:/bin", DEVELOPER_DIR: xcodeBeta });
          // Claude's probes and the terminal's Claude environment are built through this.
          const claude = yield* makeClaudeEnvironment({ homePath: "" }, stale);
          assert.strictEqual(claude.DEVELOPER_DIR, xcodeBeta);
          const instanceOwn = { DEVELOPER_DIR: "/Applications/Other.app/Contents/Developer" };
          assert.strictEqual(forSpawn(instanceOwn), instanceOwn);
        }),
      );
    });
  });

  it.effect("gives copies taken with the tools the empty folder once they are gone", () => {
    const env: NodeJS.ProcessEnv = {};
    return Effect.gen(function* () {
      const drained = yield* Deferred.make<void>();
      const changes = Stream.make(missing).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain)),
      );
      yield* withAgentDeveloperDir(env, systemGitWith(present, changes), (emptyDir) =>
        Effect.gen(function* () {
          yield* Deferred.await(drained);
          const { forSpawn } = yield* AgentDeveloperDir.AgentDeveloperDir;
          assert.deepEqual(forSpawn({ PATH: "/usr/bin:/bin" }), {
            PATH: "/usr/bin:/bin",
            DEVELOPER_DIR: emptyDir,
          });
          const instanceOwn = { DEVELOPER_DIR: "/Applications/Other.app/Contents/Developer" };
          assert.strictEqual(forSpawn(instanceOwn), instanceOwn);
        }),
      );
    });
  });

  it.effect("reaches a child started from the server's environment", () => {
    const env = process.env;
    const before = env.DEVELOPER_DIR;
    return withAgentDeveloperDir(env, systemGitWith(missing), (emptyDir) =>
      Effect.gen(function* () {
        // Agents are spawned from the server's environment, like this child.
        const child = NodeChildProcess.spawnSync(
          process.execPath,
          ["-e", "process.stdout.write(process.env.DEVELOPER_DIR ?? '')"],
          { encoding: "utf8" },
        );
        assert.strictEqual(child.stdout, emptyDir);
        if ((yield* HostProcess.Platform) !== "darwin" || !NodeFS.existsSync("/usr/bin/xcrun")) {
          return;
        }
        // Apple's stub refuses at once with a plain error; it never reaches the install dialog.
        const stub = NodeChildProcess.spawnSync("/usr/bin/git", ["--version"], {
          encoding: "utf8",
        });
        assert.notStrictEqual(stub.status, 0);
        assert.include(stub.stderr, "xcrun: error: invalid DEVELOPER_DIR path");
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (before === undefined) delete env.DEVELOPER_DIR;
          else env.DEVELOPER_DIR = before;
        }),
      ),
    );
  });
});
