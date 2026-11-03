import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestReference } from "./pullRequestLinkInput.ts";

describe("parsePullRequestReference", () => {
  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });
});
