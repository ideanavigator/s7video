import type { DesktopBridge, DesktopCliCommandState, DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type BootErrorEnvironment,
  buildErrorReport,
  resolveTriageCommand,
  updateActionFor,
  bugReportUrl,
} from "./bootError";

const desktopWith = (getState: () => Promise<DesktopCliCommandState>) =>
  ({ cliCommand: { getState } }) as unknown as DesktopBridge;

const notOnPath = (launcherPath: string | null): DesktopCliCommandState => ({
  supported: launcherPath !== null,
  installedPath: null,
  onPath: false,
  launcherPath,
});

describe("resolveTriageCommand", () => {
  it("prefers the CLI on PATH, then the desktop launcher", async () => {
    const onPath = { ...notOnPath("/home/me/.t3/bin/t3"), onPath: true };
    await expect(resolveTriageCommand(desktopWith(async () => onPath))).resolves.toBe(
      "s7video triage",
    );
    await expect(
      resolveTriageCommand(desktopWith(async () => notOnPath("/home/me/.t3/bin/t3"))),
    ).resolves.toBe("/home/me/.t3/bin/t3 triage");
  });

  it("quotes launcher paths for the shell that runs them", async () => {
    await expect(
      resolveTriageCommand(desktopWith(async () => notOnPath("/Users/O'Neil/.t3/bin/t3"))),
    ).resolves.toBe(`'/Users/O'"'"'Neil/.t3/bin/t3' triage`);
    await expect(
      resolveTriageCommand(desktopWith(async () => notOnPath("C:\\Users\\Me\\.t3\\bin\\t3.cmd"))),
    ).resolves.toBe("C:\\Users\\Me\\.t3\\bin\\t3.cmd triage");
    await expect(
      resolveTriageCommand(
        desktopWith(async () => notOnPath("C:\\Users\\Jo O'Neil\\.t3\\bin\\t3.cmd")),
      ),
    ).resolves.toBe("& 'C:\\Users\\Jo O''Neil\\.t3\\bin\\t3.cmd' triage");
  });

  it("falls back to the CLI name without a usable desktop launcher", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveTriageCommand(undefined)).resolves.toBe("s7video triage");
    await expect(resolveTriageCommand({} as DesktopBridge)).resolves.toBe("s7video triage");
    await expect(resolveTriageCommand(desktopWith(async () => notOnPath(null)))).resolves.toBe(
      "s7video triage",
    );
    const staleWindowsPathEntry = { ...notOnPath(null), supported: true, onPath: true };
    await expect(
      resolveTriageCommand(desktopWith(async () => staleWindowsPathEntry)),
    ).resolves.toBe("s7video triage");
    await expect(
      resolveTriageCommand(desktopWith(() => Promise.reject(new Error("ipc closed")))),
    ).resolves.toBe("s7video triage");
  });
});

const environment: BootErrorEnvironment = {
  version: "0.1.3-nightly.20261026.3707",
  channel: "nightly",
  surface: "web",
  platform: "MacIntel",
  userAgent: "Test",
  time: "2026-10-26T00:00:00.000Z",
};

describe("buildErrorReport", () => {
  it("drops hosts and tokens from URLs in the error", () => {
    const error = new TypeError(
      "Failed to fetch dynamically imported module: http://studio.tail1234.ts.net:3773/assets/a.js?pair=SECRET#token=SECRET",
      {
        cause: new Error(
          "ws://studio.tail1234.ts.net:3773/ws?token=SECRET closed, main-a.js?sig=SECRET",
        ),
      },
    );
    error.stack = `TypeError: ${error.message}\n    at http://studio.tail1234.ts.net:3773/src/main.tsx?t=1:10:5`;
    const report = buildErrorReport(error, environment);
    expect(report).not.toContain("SECRET");
    expect(report).not.toContain("tail1234");
    expect(report).toContain("module: /assets/a.js\n    at /src/main.tsx:10:5");
    expect(report).toContain("Caused by: Error: /ws closed, main-a.js");
    expect(report).toContain("Version: 0.1.3-nightly.20261026.3707");
  });

  it("keeps the header when a Firefox stack frame starts with the error name", () => {
    const error = new Error("boot failed");
    error.stack = "ErrorBoundary@/assets/main.js:1:2";
    expect(buildErrorReport(error, environment)).toMatch(
      /^Error: boot failed\nErrorBoundary@\/assets\/main.js:1:2\n/,
    );
    const unnamed = new Error();
    unnamed.stack = "ErrorBoundary@/assets/main.js:1:2";
    expect(buildErrorReport(unnamed, environment)).toMatch(/^Error\nErrorBoundary@/);
  });

  it("stops at cause cycles and survives values that are not errors", () => {
    const loop = new Error("outer");
    loop.cause = loop;
    expect(buildErrorReport(loop, environment).match(/outer/g)).toHaveLength(1);
    expect(buildErrorReport("plain text", environment)).toMatch(/^plain text\n/);
    expect(buildErrorReport({ code: 42 }, environment)).toMatch(/^\{"code":42\}\n/);
    expect(buildErrorReport(Object.create(null), environment)).toMatch(/^\{\}\n/);
    expect(buildErrorReport(undefined, environment)).toMatch(/^\(no error message\)\n/);
  });

  it("cuts long errors but keeps the environment", () => {
    const report = buildErrorReport("x".repeat(20_000), environment);
    expect(report).toContain("[truncated]");
    expect(report.length).toBeLessThan(7_000);
    expect(report).toContain("Time: 2026-10-26T00:00:00.000Z");
  });
});

describe("updateActionFor", () => {
  it("offers an action only when a newer build exists", () => {
    const state = (status: DesktopUpdateState["status"], downloadPercent: number | null = null) =>
      ({ status, downloadPercent }) as DesktopUpdateState;
    expect(updateActionFor(state("available"))).toEqual({ kind: "download" });
    expect(updateActionFor(state("downloading", 41.6))).toEqual({
      kind: "downloading",
      percent: 42,
    });
    expect(updateActionFor(state("downloaded"))).toEqual({ kind: "install" });
    for (const status of ["disabled", "idle", "checking", "up-to-date", "error"] as const) {
      expect(updateActionFor(state(status))).toBeNull();
    }
    expect(updateActionFor(undefined)).toBeNull();
  });
});

describe("bugReportUrl", () => {
  const environment = {
    version: "0.1.6",
    channel: "latest",
    surface: "desktop",
    platform: "macOS",
  };

  it("opens the bug form on the configured repository", () => {
    const url = new URL(
      bugReportUrl("https://github.com/ideanavigator/s7video/issues", environment)!,
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/ideanavigator/s7video/issues/new",
    );
    expect(url.searchParams.get("template")).toBe("bug.yml");
    expect(url.searchParams.get("version")).toBe("0.1.6 (latest)");
    expect(bugReportUrl("https://example.com/support/", environment)).toMatch(
      /^https:\/\/example\.com\/support\/new\?/,
    );
  });

  it("hides the link instead of throwing when no issues URL is set", () => {
    expect(bugReportUrl("", environment)).toBeNull();
  });
});
