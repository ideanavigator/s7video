// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// A project's media library (S7V-025): the live Assets list and the import, relink and remove
// commands. Removing goes through the edit document like any other edit, so it can be undone.
import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createMediaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  return {
    library: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:media:library",
      tag: WS_METHODS.mediaSubscribe,
    }),
    plan: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:media:import-plan",
      tag: WS_METHODS.mediaImportPlan,
    }),
    importMedia: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:media:import",
      tag: WS_METHODS.mediaImport,
    }),
    relink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:media:relink",
      tag: WS_METHODS.mediaRelink,
    }),
    readEdit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:edit:get",
      tag: WS_METHODS.editGet,
    }),
    applyEdit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:edit:apply",
      tag: WS_METHODS.editApply,
    }),
  };
}
