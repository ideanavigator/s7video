import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { hasCodeHosts } from "../lib/codeHosts";
import GitActionsControl from "./GitActionsControl";

// S7V-057: s7video registers no code hosts (S7V-018), so publishing has no provider to offer.
describe("GitActionsControl with no code hosts", () => {
  it("renders the Git actions row instead of crashing on the publish dialog", async () => {
    expect(hasCodeHosts()).toBe(false);
    await using screen = await render(<GitActionsControl gitCwd="/repo" activeThreadRef={null} />);

    await expect.element(screen.getByRole("button", { name: /commit/i }).first()).toBeVisible();
  });
});
