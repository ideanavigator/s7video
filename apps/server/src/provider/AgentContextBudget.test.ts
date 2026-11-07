import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { toolHandlerServices } from "../mcp/McpTools.testkit.ts";
import { VIDEO_PROJECT_TOOL_NAMES } from "../mcp/toolkits/video/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import budget from "./agentContextBudget.json" with { type: "json" };
import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";
import { resolveBuiltInSkillsPluginDir } from "../skills/BuiltInSkills.ts";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

// The model sees these fields. outputSchema and annotations are protocol metadata.
const toolListJson = (tools: ReadonlyArray<{ readonly tool: McpSchema.Tool }>) =>
  JSON.stringify(
    tools.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );

// s7video (S7V-072): what a video project's top-level thread is offered, links off.
const videoThreadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-context-budget"),
  requestNamespace: "context-budget",
  thread: {
    threadId: ThreadId.make("thread-context-budget"),
    providerSessionId: "context-budget",
    providerInstanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview", "video"]),
  issuedAt: 1,
  linkedEnvironments: false,
};
const clientProfile = { protocolVersion: "2025-06-18", capabilities: {} };

const claudeSystemAppend = (videoToolsAvailable = false) => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
    videoToolsAvailable,
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexAdditionalContext = (video = false) =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true, video },
    ),
  )
    .map((entry) => entry.value)
    .join("");

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
// Video threads list each built-in skill as one `- name: description` line (S7V-048); the body
// loads only when the skill is used. Codex adds `(file: r1/<skill>/SKILL.md)` and one root line.
const builtInSkills = Effect.gen(function* () {
  const pluginDir = yield* resolveBuiltInSkillsPluginDir({});
  assert(pluginDir !== undefined, "the built-in skills folder is missing");
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  const skills = yield* discoverClaudeSkills({ homePath: home }, undefined, {}, [pluginDir]);
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(skills, (skill) =>
    fileSystem.readFileString(skill.path).pipe(
      Effect.map((text) => ({
        listing: `- ${skill.name}: ${skill.description ?? ""}\n`,
        body: text.split(/^---$/mu)[2]!.trim(),
      })),
    ),
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const skills = yield* builtInSkills;
    const toolList = JSON.stringify(mcp.tools.map(({ tool }) => tool));
    const videoTools = yield* Effect.sync(() =>
      mcp.tools.filter(({ annotations }) => {
        const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
        return enabledWhen === undefined || enabledWhen(clientProfile);
      }),
    ).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, videoThreadScope));
    for (const { body } of skills) {
      for (const context of [claudeSystemAppend(), codexAdditionalContext(), toolList]) {
        expect(context.includes(body.slice(0, 80))).toBe(false);
      }
    }
    const measured = {
      builtInSkillListingBytes: skills.reduce((sum, skill) => sum + utf8Bytes(skill.listing), 0),
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
      codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext()),
      // s7video: a video project's thread also gets the video edit line (S7V-041).
      claudeSystemAppendVideoBytes: utf8Bytes(claudeSystemAppend(true)),
      codexAdditionalContextVideoBytes: utf8Bytes(codexAdditionalContext(true)),
      mcpToolListJsonBytes: utf8Bytes(toolListJson(mcp.tools)),
      // s7video (S7V-072): the tool-adding cards build against this number.
      mcpToolListVideoJsonBytes: utf8Bytes(toolListJson(videoTools)),
    };
    expect(videoTools.map(({ tool }) => tool.name).toSorted()).toEqual(
      [...VIDEO_PROJECT_TOOL_NAMES].toSorted(),
    );
    expect(measured.mcpToolListVideoJsonBytes).toBeLessThanOrEqual(
      measured.mcpToolListJsonBytes * 0.3,
    );

    expect(
      measured,
      "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
    ).toEqual(budget);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerTools.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(toolHandlerServices),
      ),
    ),
  ),
);
