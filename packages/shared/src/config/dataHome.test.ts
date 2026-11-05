// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - Builds a fake home with a symlink on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DATA_HOME_ENV,
  UPSTREAM_T3_HOME_DIR,
  UpstreamT3HomeError,
  defaultDataHome,
  guardDataHome,
  isUpstreamT3Home,
} from "./dataHome.ts";

const posixJoin = (...parts: string[]) =>
  parts
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/[^/]+\/\.\.\//g, "/");

const HOME = "/Users/someone";

describe("dataHome", () => {
  it("defaults to ~/.s7video, never T3 Code's ~/.t3", () => {
    const home = defaultDataHome(HOME, posixJoin);
    expect(home).toBe("/Users/someone/.s7video");
    expect(isUpstreamT3Home(home, HOME)).toBe(false);
    expect(DATA_HOME_ENV).toBe("S7VIDEO_HOME");
  });

  it.each([
    `${HOME}/${UPSTREAM_T3_HOME_DIR}`,
    `${HOME}/.t3/`,
    `${HOME}/.t3/userdata`,
    `${HOME}/.t3/dev`,
  ])("refuses %s", (baseDir) => {
    expect(isUpstreamT3Home(baseDir, HOME)).toBe(true);
    expect(() => guardDataHome(baseDir, HOME)).toThrow(UpstreamT3HomeError);
    expect(() => guardDataHome(baseDir, HOME)).toThrow(/T3 Code's data folder/);
  });

  it("refuses Windows paths to ~/.t3 regardless of case and separators", () => {
    expect(isUpstreamT3Home("C:\\Users\\Someone\\.T3\\userdata", "c:\\users\\someone")).toBe(true);
  });

  it.each([`${HOME}/.s7video`, `${HOME}/.s7video/dev`, `${HOME}/.t3-other`, "/tmp/.t3"])(
    "allows %s",
    (baseDir) => {
      expect(guardDataHome(baseDir, HOME)).toBe(baseDir);
    },
  );

  it("refuses ~/.T3 on case-insensitive platforms only", () => {
    expect(isUpstreamT3Home(`${HOME}/.T3/userdata`, HOME, { platform: "darwin" })).toBe(true);
    expect(isUpstreamT3Home(`${HOME}/.T3/userdata`, HOME, { platform: "win32" })).toBe(true);
    expect(isUpstreamT3Home(`${HOME}/.T3/userdata`, HOME, { platform: "linux" })).toBe(false);
  });

  it("refuses a symlink that resolves into ~/.t3", () => {
    const home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s7video-home-")),
    );
    NodeFS.mkdirSync(NodePath.join(home, ".t3", "userdata"), { recursive: true });
    NodeFS.symlinkSync(NodePath.join(home, ".t3"), NodePath.join(home, "innocent"));
    expect(() => guardDataHome(NodePath.join(home, "innocent", "userdata"), home)).toThrow(
      UpstreamT3HomeError,
    );
    expect(() => guardDataHome(NodePath.join(home, "innocent", "not-yet"), home)).toThrow(
      UpstreamT3HomeError,
    );
    expect(guardDataHome(NodePath.join(home, ".s7video"), home)).toBe(
      NodePath.join(home, ".s7video"),
    );
  });
});
