// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lists the built-in skills in edit projects only (S7V-048)", () =>
  Effect.gen(function* () {
    // No Claude CLI in tests: the capability probe fails and the snapshot keeps the scanned skills.
    vi.mocked(query).mockImplementation(() => {
      throw new Error("no Claude CLI in tests");
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7-claude-skills-home-" });
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7-claude-skills-cwd-" });
    const settings = yield* decodeClaudeSettings({ homePath: home });
    const machine = { skills: [], slashCommands: [] } as unknown as ServerProvider;
    const names = (snapshot: { readonly skills: ReadonlyArray<{ readonly name: string }> }) =>
      snapshot.skills.map((skill) => skill.name);

    const plain = yield* probeClaudeWorkspaceSnapshot(settings, machine, cwd, { HOME: home });
    assert.deepEqual(names(plain), []);

    yield* fileSystem.writeFileString(path.join(cwd, "edit.json"), "{}\n");
    yield* fileSystem.writeFileString(path.join(cwd, "project.json"), "{}\n");
    const video = yield* probeClaudeWorkspaceSnapshot(settings, machine, cwd, { HOME: home });
    assert.deepEqual(names(video), ["video:remove-silences"]);
  }).pipe(
    Effect.ensuring(Effect.sync(() => vi.mocked(query).mockRestore())),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
