// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { BRAND } from "@t3tools/shared/brand";
import type { ThirdPartyLicenseManifest } from "@t3tools/shared/thirdPartyLicenses";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";

const MANIFEST: ThirdPartyLicenseManifest = {
  schemaVersion: 1,
  entries: [
    {
      bundles: ["desktop", "server", "web"],
      kind: "custom",
      license: BRAND.credits.license,
      name: BRAND.credits.upstreamName,
      noticeText: "MIT License\n\nCopyright (c) 2026 Upstream authors",
      sourceUrl: BRAND.credits.upstreamUrl,
      version: null,
    },
    {
      bundles: ["web"],
      kind: "package",
      license: "Apache-2.0",
      name: "another-package",
      noticeText: "Apache License Version 2.0",
      sourceUrl: null,
      version: "1.0.0",
    },
  ],
};

describe("OpenSourceLicensesPanel", () => {
  it("finds the upstream project by keyboard search and shows its licence text", async () => {
    using _fetch = stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json(MANIFEST)),
    );
    await using screen = await render(<OpenSourceLicensesPanel />);

    await expect
      .element(screen.getByText(new RegExp(`^${BRAND.app.productName} includes the open-source`)))
      .toBeVisible();
    await expect.element(screen.getByText("2 notices")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Search open-source licenses" }));
    await userEvent.keyboard(BRAND.credits.upstreamName.slice(0, 2));
    await expect.element(screen.getByText("1 of 2")).toBeVisible();
    expect(screen.getByText("another-package").elements()).toHaveLength(0);

    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(BRAND.credits.upstreamName) }),
    );
    await expect.element(screen.getByText(/Copyright \(c\) 2026 Upstream authors/)).toBeVisible();
  });
});
