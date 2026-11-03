import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "./threadPullRequestCompatibility.ts";

const reference = {
  host: "github.example",
  repository: "team/repo",
  number: 7,
  url: "https://github.example/team/repo/pull/7",
};
const input = {
  threadId: ThreadId.make("thread"),
  reference,
  linked: true,
};
const capabilities = { repositoryIdentity: true } satisfies ExecutionEnvironmentCapabilities;

describe("thread pull request capability negotiation", () => {
  it("does not dispatch before the server config loads", () => {
    expect(threadPullRequestLinkMode(undefined)).toBe("unsupported");
    expect(planThreadPullRequestMutation({ ...input, capabilities: undefined })).toBeNull();
  });
  it("plans link and unlink commands", () => {
    expect(planThreadPullRequestMutation({ ...input, capabilities })).toEqual({
      type: "thread.pull-request.link",
      input: { threadId: input.threadId, ...reference, source: "manual" },
    });
    expect(planThreadPullRequestMutation({ ...input, capabilities, linked: false })).toEqual({
      type: "thread.pull-request.unlink",
      input: {
        threadId: input.threadId,
        host: reference.host,
        repository: reference.repository,
        number: reference.number,
      },
    });
  });
});
