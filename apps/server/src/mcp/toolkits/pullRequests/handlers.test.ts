import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  PullRequestOperationError,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { listThreadPullRequests } from "./handlers.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

interface HarnessOptions {
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => string | null;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
}

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
      listShells: () => Effect.succeed(options.projects ?? (project ? [project] : [])),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: () => Effect.succeed(NO_GUIDE),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === THREAD_ID && thread ? v2PullRequestThread(thread) : null),
      dispatch,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { commands, guideRequests, call };
});

describe("pull request toolkit handlers", () => {
  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("unlinks every visible pull request in the given states in one call", () =>
    Effect.gen(function* () {
      const withState = (number: number, state: "open" | "closed" | "merged") => {
        const link = makeLink(number, { headBranch: `branch-${number}` });
        return { ...link, snapshot: { ...link.snapshot!, state } };
      };
      const harness = yield* makeHarness({
        thread: makeThread([
          withState(1, "merged"),
          withState(2, "open"),
          withState(3, "closed"),
          makeLink(4),
          { ...withState(5, "merged"), source: "stack-dismissed" },
        ]),
      });
      const result = yield* harness.call("unlink_pull_requests", {
        states: ["closed", "merged"],
      });
      expect(result).toEqual({
        unlinked: [
          { host: "github.com", repository: "t3tools/t3code", state: "merged", numbers: [1] },
          { host: "github.com", repository: "t3tools/t3code", state: "closed", numbers: [3] },
        ],
        unlinkedCount: 2,
        remaining: 2,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 1 },
        { type: "thread.pull-request.unlink", number: 3 },
      ]);
    }),
  );

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });
});
