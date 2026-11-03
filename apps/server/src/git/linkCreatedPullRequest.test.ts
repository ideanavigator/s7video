import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitRunStackedActionResult,
  type OrchestrationProjectShell,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { refreshPushedPullRequests } from "./refreshPushedPullRequests.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { createdPullRequestKey } from "./linkCreatedPullRequest.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.acme.test/platform/api",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.acme.test:Platform/API.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "Platform/API",
    owner: "Platform",
    name: "API",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const thread: PullRequestTestThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
};

function prResult(pr: GitRunStackedActionResult["pr"]): Pick<GitRunStackedActionResult, "pr"> {
  return { pr };
}

describe("createdPullRequestKey", () => {
  it("falls back to the project's host and repository for an unreadable URL", () => {
    expect(
      createdPullRequestKey(
        prResult({ status: "opened_existing", number: 3, url: "https://ghe.internal/x/3" }),
        project,
      ),
    ).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 3,
      url: "https://ghe.internal/x/3",
    });
    expect(
      createdPullRequestKey(
        prResult({ status: "created", number: 3, url: "https://ghe.internal/x/3" }),
        undefined,
      ),
    ).toBeNull();
  });
});

it.effect(
  "refreshes PR readers after a push from a thread or project, but not a local commit",
  () =>
    Effect.gen(function* () {
      const refreshed: string[] = [];
      const layerDependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () => Effect.succeed(v2PullRequestThread(thread)),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: (id) =>
            Effect.sync(() => {
              refreshed.push(id);
            }),
        }),
      );
      yield* refreshPushedPullRequests(
        { cwd: "/worktree", threadId: THREAD_ID },
        { push: { status: "pushed" } },
      ).pipe(Effect.provide(layerDependencies));
      yield* refreshPushedPullRequests(
        { cwd: project.workspaceRoot },
        { push: { status: "pushed" } },
      ).pipe(Effect.provide(layerDependencies));
      yield* refreshPushedPullRequests({ cwd: "/unrelated" }, { push: { status: "pushed" } }).pipe(
        Effect.provide(layerDependencies),
      );
      yield* refreshPushedPullRequests(
        { cwd: project.workspaceRoot, threadId: THREAD_ID },
        { push: { status: "skipped_not_requested" } },
      ).pipe(Effect.provide(layerDependencies));
      yield* refreshPushedPullRequests(
        { cwd: "/draft-worktree", projectId: PROJECT_ID },
        { push: { status: "pushed" } },
      ).pipe(Effect.provide(layerDependencies));
      expect(refreshed).toEqual([PROJECT_ID, PROJECT_ID, PROJECT_ID]);
    }),
);
