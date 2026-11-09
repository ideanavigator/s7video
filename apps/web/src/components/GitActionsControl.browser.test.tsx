import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { hasCodeHosts } from "../lib/codeHosts";
import GitActionsControl from "./GitActionsControl";

const systemGit = vi.hoisted(() => ({ available: true }));
vi.mock(import("~/state/systemGit"), () => ({
  useSystemGitAvailable: () => systemGit.available,
}));

// S7V-057: s7video registers no code hosts (S7V-018), so publishing has no provider to offer.
describe("GitActionsControl with no code hosts", () => {
  it("renders the Git actions row instead of crashing on the publish dialog", async () => {
    systemGit.available = true;
    expect(hasCodeHosts()).toBe(false);
    await using screen = await render(<GitActionsControl gitCwd="/repo" activeThreadRef={null} />);

    await expect.element(screen.getByRole("button", { name: /commit/i }).first()).toBeVisible();
  });
});

// S7V-052: on a Mac without the developer tools git UI is absent, never shown disabled.
describe("GitActionsControl without a system git", () => {
  it("shows no git actions and no Initialize Git", async () => {
    systemGit.available = false;
    await using screen = await render(
      <div data-testid="host">
        <GitActionsControl gitCwd="/repo" activeThreadRef={null} />
      </div>,
    );

    await expect.element(screen.getByTestId("host")).toBeEmptyDOMElement();
    expect(screen.container.textContent).not.toMatch(/initialize git|commit/i);
  });
});
