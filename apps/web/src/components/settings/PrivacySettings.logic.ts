// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { ServerUsageData } from "@t3tools/contracts";

/** The sharing switch is offered only by servers whose build names a destination. */
export function offeredUsageData(
  environments: ReadonlyArray<{
    readonly serverConfig?: { readonly usageData?: ServerUsageData } | null;
  }>,
): { readonly variable: string | undefined } | null {
  const offered = environments.flatMap((environment) => {
    const usageData = environment.serverConfig?.usageData;
    return usageData?.available ? [usageData] : [];
  });
  if (offered.length === 0) return null;
  return { variable: offered.find((usageData) => usageData.variable)?.variable };
}
