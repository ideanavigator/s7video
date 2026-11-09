// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "./server";

/**
 * Whether the environment's host has a real git (S7V-052). Older servers do not say, so they count
 * as having one. Without git the branch toolbar, diff git views and git actions are not shown.
 */
export function useSystemGitAvailable(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(serverEnvironment.configValueAtom(environmentId))?.systemGit !== false;
}
