import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";

/** In the shared registry's order, which is the order hosts are listed and probed in. */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST: ReadonlyArray<SourceControlDriver> = [];

export const sourceControlDefinitions = builtInSourceControlDefinitions;
