// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { BRAND } from "@t3tools/shared/brand";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { APP_ICON_URL, AppIcon } from "./AppIcon";
import { AppWordmark } from "./AppWordmark";

describe("AppWordmark", () => {
  it("reads the product name from the brand config", () => {
    const html = renderToStaticMarkup(<AppWordmark className="text-lg" />);
    expect(BRAND.app.productName).toBe("s7video");
    expect(html).toContain(">s7video</span>");
    expect(html).toContain("text-lg");
    expect(html).not.toMatch(/T3/);
  });
});

describe("AppIcon", () => {
  it("shows the touch icon the icon export copies into the web app", () => {
    expect(renderToStaticMarkup(<AppIcon className="size-4" />)).toContain(
      `<img src="${APP_ICON_URL}" alt="" class="size-4"/>`,
    );
  });
});
