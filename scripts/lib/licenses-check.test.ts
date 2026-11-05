// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Reads the committed allowlist and exceptions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_BRAND_CONFIG_PATH, loadBrandConfigFile } from "./brand-config.ts";
import {
  checkLicences,
  judgeLicence,
  packagesFromPnpm,
  parseLicenceExpression,
  type LicenceAllowlist,
  type LicenceException,
  type ScannedPackage,
} from "./licenses-check.ts";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const ALLOWLIST = JSON.parse(
  NodeFS.readFileSync(NodePath.join(ROOT, "licenses.allowlist.json"), "utf8"),
) as LicenceAllowlist;
const EXCEPTIONS = (
  JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, "licenses.exceptions.json"), "utf8")) as {
    exceptions: ReadonlyArray<LicenceException>;
  }
).exceptions;

function scanned(overrides: Partial<ScannedPackage> & { name: string }): ScannedPackage {
  return {
    version: "1.0.0",
    license: "MIT",
    path: `node_modules/.pnpm/${overrides.name.replace("/", "+")}@1.0.0/node_modules/${overrides.name}`,
    scope: "production",
    ...overrides,
  };
}

function check(
  packages: ReadonlyArray<ScannedPackage>,
  extra: Partial<Parameters<typeof checkLicences>[0]> = {},
) {
  return checkLicences({ packages, allowlist: ALLOWLIST, exceptions: [], overrides: [], ...extra });
}

describe("allowlist", () => {
  it.each(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "OFL-1.1", "0BSD"])(
    "accepts %s",
    (license) => {
      expect(judgeLicence(license, "production", ALLOWLIST)).toMatchObject({ ok: true });
    },
  );

  it.each(["GPL-3.0-only", "AGPL-3.0-or-later", "LGPL-3.0-or-later", "SSPL-1.0", "BUSL-1.1"])(
    "rejects %s",
    (license) => {
      expect(judgeLicence(license, "production", ALLOWLIST).ok).toBe(false);
    },
  );

  it("matches ids case-insensitively and maps known misspellings", () => {
    expect(judgeLicence("apache-2.0", "production", ALLOWLIST)).toEqual({
      ok: true,
      elected: "Apache-2.0",
    });
    expect(judgeLicence("MIT/X11", "production", ALLOWLIST)).toEqual({ ok: true, elected: "MIT" });
  });
});

describe("SPDX expressions", () => {
  it("parses AND, OR, WITH and parentheses", () => {
    expect(parseLicenceExpression("(MIT AND (Zlib OR GPL-2.0-only WITH Classpath-exception-2.0))"))
      .toMatchInlineSnapshot(`
        {
          "kind": "and",
          "left": {
            "id": "MIT",
            "kind": "id",
          },
          "right": {
            "kind": "or",
            "left": {
              "id": "Zlib",
              "kind": "id",
            },
            "right": {
              "id": "GPL-2.0-only WITH Classpath-exception-2.0",
              "kind": "id",
            },
          },
        }
      `);
    expect(parseLicenceExpression("SEE LICENSE IN README.md")).toBeNull();
    expect(parseLicenceExpression("(MIT OR")).toBeNull();
  });

  it("passes (MIT OR GPL-3.0) through MIT and fails (MIT AND GPL-3.0)", () => {
    expect(judgeLicence("(MIT OR GPL-3.0-or-later)", "production", ALLOWLIST)).toEqual({
      ok: true,
      elected: "MIT",
    });
    expect(judgeLicence("(MIT AND GPL-3.0-or-later)", "production", ALLOWLIST).ok).toBe(false);
  });

  it("elects the most permissive option and honours a recorded election", () => {
    expect(judgeLicence("(MPL-2.0 OR Apache-2.0)", "production", ALLOWLIST).elected).toBe(
      "Apache-2.0",
    );
    expect(judgeLicence("(MIT OR Apache-2.0)", "production", ALLOWLIST, "Apache-2.0")).toEqual({
      ok: true,
      elected: "Apache-2.0",
    });
    expect(judgeLicence("(MIT OR GPL-3.0-only)", "production", ALLOWLIST, "GPL-3.0-only").ok).toBe(
      false,
    );
    expect(judgeLicence("MIT", "production", ALLOWLIST, "Apache-2.0").ok).toBe(false);
  });

  it("records the dual-licence choices for jszip and dompurify", () => {
    const result = check([
      scanned({ name: "jszip", license: "(MIT OR GPL-3.0-or-later)" }),
      scanned({ name: "dompurify", license: "(MPL-2.0 OR Apache-2.0)" }),
      scanned({ name: "plain", license: "(MIT AND Zlib)" }),
    ]);
    expect(result.problems).toEqual([]);
    expect(result.elections.map(({ name, elected }) => `${name}: ${elected}`)).toEqual([
      "jszip: MIT",
      "dompurify: Apache-2.0",
    ]);
  });
});

describe("checkLicences", () => {
  it("fails a package with no licence and prints where it is installed", () => {
    const result = check([scanned({ name: "mystery", license: "Unknown" })]);
    expect(result.problems).toEqual([
      expect.objectContaining({
        name: "mystery",
        message: "has no SPDX licence",
        path: "node_modules/.pnpm/mystery@1.0.0/node_modules/mystery",
      }),
    ]);
  });

  it("fails an AGPL package deep in the tree", () => {
    const tree = [
      scanned({ name: "app-lib" }),
      scanned({ name: "helper", license: "ISC" }),
      scanned({ name: "deep-agpl", license: "AGPL-3.0-only", scope: "development" }),
    ];
    expect(check(tree).problems.map((problem) => problem.name)).toEqual(["deep-agpl"]);
  });

  it("uses a package override from the notices config when the metadata is missing", () => {
    const packages = [
      scanned({ name: "jsbi", license: "Unknown" }),
      scanned({
        name: "@scope/sibling",
        license: "Unknown",
        repositoryUrl: "git+https://github.com/example/mono.git",
      }),
    ];
    const result = check(packages, {
      overrides: [
        { name: "jsbi", license: "Apache-2.0" },
        { repositoryUrl: "https://github.com/example/mono", license: "MIT" },
      ],
    });
    expect(result.problems).toEqual([]);
  });

  it("accepts WTFPL only for development tooling", () => {
    const result = check([
      scanned({ name: "build-only", license: "WTFPL", scope: "development" }),
      scanned({ name: "shipped", license: "WTFPL" }),
    ]);
    expect(result.problems.map((problem) => problem.name)).toEqual(["shipped"]);
  });

  it("fails a patched MPL-2.0 package", () => {
    const result = check([scanned({ name: "mpl-lib", license: "MPL-2.0" })], {
      patched: new Set(["mpl-lib@1.0.0"]),
    });
    expect(result.problems[0]?.message).toMatch(/unmodified/);
  });

  it("honours an exception only when it names an ADR", () => {
    const sdk = scanned({ name: "closed-sdk", license: "SEE LICENSE IN README.md" });
    const withAdr = check([sdk], {
      exceptions: [{ name: "closed-sdk", adr: "ADR-002", reason: "Reviewed." }],
    });
    expect(withAdr.problems).toEqual([]);
    expect(withAdr.configErrors).toEqual([]);
    expect(withAdr.exceptions).toEqual([expect.objectContaining({ adr: "ADR-002" })]);

    const withoutAdr = check([sdk], { exceptions: [{ name: "closed-sdk", reason: "Trust me." }] });
    expect(withoutAdr.problems.map((problem) => problem.name)).toEqual(["closed-sdk"]);
    expect(withoutAdr.configErrors).toEqual([
      expect.stringMatching(/must name the ADR that accepted it/),
    ]);
  });

  it("rejects an exception for a package that is no longer installed", () => {
    const result = check([], {
      exceptions: [{ name: "gone", adr: "ADR-009", reason: "Was needed once." }],
    });
    expect(result.configErrors).toEqual([expect.stringMatching(/gone, which is not installed/)]);
  });

  it("covers the Claude Agent SDK through ADR-002", () => {
    const result = check(
      [scanned({ name: "@anthropic-ai/claude-agent-sdk", license: "Unknown" })],
      { exceptions: EXCEPTIONS },
    );
    expect(result.problems).toEqual([]);
    expect(result.exceptions.map((exception) => exception.adr)).toEqual(["ADR-002"]);
  });
});

describe("packagesFromPnpm", () => {
  it("marks copies outside the production tree as development and keeps one row per path", () => {
    const root = "/repo";
    const all = {
      MIT: [
        {
          name: "@scope/pkg",
          versions: ["1.0.0", "2.0.0"],
          paths: [
            "/repo/node_modules/.pnpm/@scope+pkg@2.0.0/node_modules/@scope/pkg",
            "/repo/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg",
          ],
        },
      ],
      WTFPL: [
        {
          name: "tool",
          versions: ["0.1.0"],
          paths: ["/repo/node_modules/.pnpm/tool@0.1.0/node_modules/tool"],
        },
      ],
    };
    const production = {
      MIT: [
        {
          name: "@scope/pkg",
          versions: ["2.0.0"],
          paths: ["/repo/node_modules/.pnpm/@scope+pkg@2.0.0/node_modules/@scope/pkg"],
        },
      ],
    };
    expect(
      packagesFromPnpm({ all, production, root }).map(
        ({ name, version, scope, license }) => `${name}@${version} ${license} ${scope}`,
      ),
    ).toEqual([
      "@scope/pkg@1.0.0 MIT development",
      "@scope/pkg@2.0.0 MIT production",
      "tool@0.1.0 WTFPL development",
    ]);
  });
});

describe("notices config", () => {
  it("credits the upstream project named in the brand config, under its licence", async () => {
    const { credits } = await loadBrandConfigFile(DEFAULT_BRAND_CONFIG_PATH);
    const config = JSON.parse(
      NodeFS.readFileSync(NodePath.join(ROOT, "third-party-licenses.config.json"), "utf8"),
    ) as {
      customNotices: ReadonlyArray<{ name: string; license: string; sourceUrl?: string }>;
    };
    expect(config.customNotices).toContainEqual(
      expect.objectContaining({
        name: credits.upstreamName,
        license: credits.license,
        sourceUrl: credits.upstreamUrl,
      }),
    );
  });
});
