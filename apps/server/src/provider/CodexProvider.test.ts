import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyPreferredCodexDefaultModel,
  codexVideoToolsVersionMessage,
  mapCodexModelCapabilities,
  probeCodexSkillsForCwd,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("asks for a Codex update only below the video tools' 0.159", () => {
  assert.equal(
    codexVideoToolsVersionMessage("codex-cli 0.137.0"),
    "Your Codex app is version 0.137.0. s7video's video tools need 0.159 or later. Update Codex, then start a new thread.",
  );
  assert.include(codexVideoToolsVersionMessage("0.158.9") ?? "", "version 0.158.9");
  for (const version of ["0.159.0", "codex-cli 0.166.0", "1.0.0", "0.160.0-alpha.1", "dev"]) {
    assert.isUndefined(codexVideoToolsVersionMessage(version), version);
  }
});

// A fake `codex app-server` that logs each request method and lists the extra roots it was given.
const FAKE_CODEX_APP_SERVER = (logPath: string) => `
const fs = require("node:fs");
let roots = [];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id === undefined) continue;
    fs.appendFileSync(${JSON.stringify(logPath)}, message.method + "\\n");
    let result = {};
    if (message.method === "initialize") {
      result = { userAgent: "probe/0.166.0", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" };
    } else if (message.method === "skills/extraRoots/set") {
      roots = message.params.extraRoots;
    } else if (message.method === "skills/list") {
      const cwd = message.params.cwds[0];
      const skills = roots.map((root) => ({ name: "remove-silences", description: "Remove silences", path: root + "/remove-silences/SKILL.md", scope: "user", enabled: true }));
      result = { data: [{ cwd, skills, errors: [] }] };
    }
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  }
});
`;

it.effect("probeCodexSkillsForCwd adds the built-in skills in edit projects only (S7V-048)", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "s7-fake-codex-" });
    const logPath = path.join(directory, "requests.log");
    yield* fs.writeFileString(path.join(directory, "server.cjs"), FAKE_CODEX_APP_SERVER(logPath));
    const binaryPath = path.join(directory, "codex");
    yield* fs.writeFileString(
      binaryPath,
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(directory, "server.cjs")}"\n`,
    );
    yield* fs.chmod(binaryPath, 0o755);
    const probe = (cwd: string) =>
      probeCodexSkillsForCwd({ binaryPath, cwd, environment: { HOME: directory } }).pipe(
        Effect.scoped,
      );
    const requests = Effect.map(fs.readFileString(logPath), (text) => text.trim().split("\n"));

    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "s7-codex-cwd-" });
    assert.deepEqual(yield* probe(cwd), []);
    assert.deepEqual(yield* requests, ["initialize", "skills/list"]);

    yield* fs.writeFileString(path.join(cwd, "edit.json"), "{}\n");
    yield* fs.writeFileString(path.join(cwd, "project.json"), "{}\n");
    yield* fs.remove(logPath);
    const skills = yield* probe(cwd);
    assert.deepEqual(yield* requests, ["initialize", "skills/extraRoots/set", "skills/list"]);
    assert.deepEqual(
      skills.map((skill) => skill.path),
      [path.resolve(import.meta.dirname, "../../skills/skills/remove-silences/SKILL.md")],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
