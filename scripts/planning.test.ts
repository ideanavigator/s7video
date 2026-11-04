// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off - resolvePlanningDir checks a real temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { PlanningDirError, resolvePlanningDir } from "./planning.ts";

function withTree<T>(run: (root: string) => T): T {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "planning-dir-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, "s7video"));
    NodeFS.mkdirSync(NodePath.join(root, "s7video-planning", "scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "s7video-planning", "scripts", "ticket-board.ts"), "");
    return run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("resolvePlanningDir", () => {
  it("defaults to the sibling s7video-planning checkout", () => {
    withTree((root) => {
      const appRoot = NodePath.join(root, "s7video");
      expect(resolvePlanningDir({}, appRoot)).toBe(NodePath.join(root, "s7video-planning"));
    });
  });

  it("uses S7V_PLANNING_DIR, relative to the app repo", () => {
    withTree((root) => {
      NodeFS.renameSync(NodePath.join(root, "s7video-planning"), NodePath.join(root, "plans"));
      const appRoot = NodePath.join(root, "s7video");
      expect(resolvePlanningDir({ S7V_PLANNING_DIR: "../plans" }, appRoot)).toBe(
        NodePath.join(root, "plans"),
      );
    });
  });

  it("should error clearly when planning repo missing", () => {
    withTree((root) => {
      const appRoot = NodePath.join(root, "s7video");
      const missing = { S7V_PLANNING_DIR: NodePath.join(root, "nowhere") };
      expect(() => resolvePlanningDir(missing, appRoot)).toThrow(PlanningDirError);
      expect(() => resolvePlanningDir(missing, appRoot)).toThrow(
        /Planning repo not found .*nowhere[\s\S]*git clone[\s\S]*S7V_PLANNING_DIR=/,
      );
      // A folder without the ticket scripts does not count as the planning repo.
      NodeFS.rmSync(NodePath.join(root, "s7video-planning", "scripts"), { recursive: true });
      expect(() => resolvePlanningDir({}, appRoot)).toThrow(/default \.\.\/s7video-planning/);
    });
  });
});
