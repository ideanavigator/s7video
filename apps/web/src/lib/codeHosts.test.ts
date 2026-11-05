import { describe, expect, it } from "vite-plus/test";

import { hasCodeHosts } from "./codeHosts";

describe("hasCodeHosts (S7V-018)", () => {
  it("hides pull request entry points in s7video, which registers no code host", () => {
    expect(hasCodeHosts()).toBe(false);
  });

  it("shows them again once a code host is registered", () => {
    expect(hasCodeHosts([{ kind: "github" }])).toBe(true);
    expect(hasCodeHosts([])).toBe(false);
  });
});
