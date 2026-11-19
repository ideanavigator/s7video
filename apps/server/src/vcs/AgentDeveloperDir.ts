// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * On a Mac without the developer tools, the agent CLIs run Apple's `/usr/bin/git` stub themselves
 * (Claude Code runs `git ls-files` at start-up), and the stub opens the install dialog (S7V-114).
 * With DEVELOPER_DIR on an empty folder every stub fails at once with "xcrun: error" instead. No
 * one helper builds the agents' environments; all start from the server's, so it is set there.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { SystemGit, type SystemGitStatus } from "./SystemGit.ts";

export class AgentDeveloperDir extends Context.Reference<{
  /**
   * `env`, copied from the server's environment earlier, with the DEVELOPER_DIR a child started
   * now should get. Provider instances keep such copies until their settings change.
   */
  readonly forSpawn: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}>("t3/vcs/AgentDeveloperDir", {
  defaultValue: () => ({ forSpawn: (env) => env }),
}) {}

/** Follows `SystemGit`: the empty folder while git is missing, the user's own value otherwise. */
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const systemGit = yield* SystemGit;
  const env = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const emptyDir = path.join(config.baseDir, "empty-developer-dir");
  const userValue = env.DEVELOPER_DIR;

  const follow = Effect.fn("AgentDeveloperDir.follow")(function* (status: SystemGitStatus) {
    if (status.available) {
      if (env.DEVELOPER_DIR !== emptyDir) return;
      if (userValue === undefined) delete env.DEVELOPER_DIR;
      else env.DEVELOPER_DIR = userValue;
      return;
    }
    yield* fs.makeDirectory(emptyDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fs.chmod(emptyDir, 0o700)),
      Effect.catch((cause) =>
        // A missing folder still makes the stub fail at once; only its ownership is lost.
        Effect.logWarning("Could not create the empty developer folder.", { cause }),
      ),
    );
    env.DEVELOPER_DIR = emptyDir;
  });

  const changes = yield* systemGit.subscribeChanges;
  yield* follow(yield* systemGit.status);
  yield* Stream.runForEach(changes, follow).pipe(Effect.forkScoped);

  return AgentDeveloperDir.of({
    forSpawn: (spawnEnv) => {
      const now = env.DEVELOPER_DIR;
      const then = spawnEnv.DEVELOPER_DIR;
      // Any other value came from the instance's own environment settings and stays.
      if (then === now || (then !== emptyDir && then !== userValue)) return spawnEnv;
      const next = { ...spawnEnv };
      if (now === undefined) delete next.DEVELOPER_DIR;
      else next.DEVELOPER_DIR = now;
      return next;
    },
  });
});

export const layer = Layer.effect(AgentDeveloperDir, make);
