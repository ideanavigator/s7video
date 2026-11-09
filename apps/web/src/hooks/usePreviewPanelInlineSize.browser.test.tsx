// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";

function Row(props: { readonly rowWidth: number; readonly fraction?: number }) {
  return (
    <div style={{ width: props.rowWidth, display: "flex" }}>
      <Panel fraction={props.fraction} />
    </div>
  );
}

function Panel(props: { readonly fraction: number | undefined }) {
  const { width, observeRow } = usePreviewPanelInlineSize({
    widthStorageKey: "test:video-project-panel-width",
    defaultWidthFraction: props.fraction,
  });
  return <output ref={(host) => (host === null ? undefined : observeRow(host))}>{width}</output>;
}

describe("usePreviewPanelInlineSize (S7V-076)", () => {
  it("takes a share of the workspace by default, within the caps", async () => {
    await page.viewport(1440, 900);
    // This hook only needs layout and React; no navigation is involved.
    await using wide = await render(<Row rowWidth={1200} fraction={0.6} />, { router: false });
    // 60% of 1200; the caps are 70% of the window (1008) and the row less the chat's 360 (840).
    await expect.element(wide.getByRole("status")).toHaveTextContent("720");

    await using plain = await render(<Row rowWidth={1200} />, { router: false });
    await expect.element(plain.getByRole("status")).toHaveTextContent("540");
  });

  it("keeps the chat at least 360 px wide at the minimum window", async () => {
    await page.viewport(1180, 760);
    await using screen = await render(<Row rowWidth={900} fraction={0.6} />, { router: false });
    // 60% would be 540, but the chat needs 360 of the row's 900.
    await expect.element(screen.getByRole("status")).toHaveTextContent("540");
    await using narrow = await render(<Row rowWidth={800} fraction={0.6} />, { router: false });
    await expect.element(narrow.getByRole("status")).toHaveTextContent("440");
  });
});
