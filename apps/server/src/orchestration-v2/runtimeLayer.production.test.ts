// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The production runtime must give the session manager its project lookup (S7V-023). It reads
 * ProjectService as optional, and memoized layers keep their first build's context, so a missing
 * provide fails silently: agents just never get the video tools. Built from `layerProduction`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    // The credential is issued before the provider opens; this test stops there.
    openSession: () => Effect.die("not opened in this test"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerProductionTest = (issued: Array<McpSessionRegistry.McpCredentialRequest>) => {
  const layerPlatform = NodeServices.layer;
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-runtime-production-" });
  return RuntimeLayer.layerProduction.pipe(
    Layer.provide(
      Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.map(McpSessionRegistry.McpSessionRegistry, (registry) =>
          McpSessionRegistry.McpSessionRegistry.of({
            ...registry,
            issue: (request) =>
              Effect.sync(() => issued.push(request)).pipe(Effect.andThen(registry.issue(request))),
          }),
        ),
      ).pipe(Layer.provide(McpSessionRegistryTestkit.layer)),
    ),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(Layer.merge(ProjectStore.layer, IdAllocator.layer)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
      ),
    ),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
        listInstances: Effect.succeed([providerInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
    ),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
      }),
    ),
    // Services the production runtime holds but this path never calls.
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(PreviewManager.PreviewManager)({}),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          directory: "/nonexistent/s7v-secret-store",
          getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("not used"),
        }),
        Layer.mock(TerminalManager.TerminalManager)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
        ManagedPolicy.layerTest(),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerConfig),
    Layer.provide(layerPlatform),
  );
};

it.effect("the production runtime gives the session manager the project lookup", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "s7v-runtime-video-" });
    yield* fileSystem.writeFileString(`${root}/edit.json`, "{}");
    yield* fileSystem.writeFileString(`${root}/project.json`, "{}");
    const issued: Array<McpSessionRegistry.McpCredentialRequest> = [];

    yield* Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectId = ProjectId.make("project-runtime-video");
      const threadId = ThreadId.make("thread-runtime-video");
      yield* projects.create({
        commandId: CommandId.make("create-project-runtime-video"),
        projectId,
        title: "Video",
        workspaceRoot: root,
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("create-thread-runtime-video"),
        threadId,
        projectId,
        title: "Video",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* manager
        .open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: root },
        })
        .pipe(Effect.exit);
    }).pipe(Effect.provide(layerProductionTest(issued)));

    assert.isTrue(issued.length > 0, "the session manager issued an MCP credential");
    assert.isTrue(issued.at(-1)?.capabilities?.has("video"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
