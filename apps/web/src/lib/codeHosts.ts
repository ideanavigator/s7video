import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

/**
 * Pull request screens only work through a registered code host. s7video ships none (S7V-018),
 * so entry points that lead to them stay hidden until one is registered.
 */
export function hasCodeHosts(
  definitions: ReadonlyArray<unknown> = sourceControlClients.definitions,
): boolean {
  return definitions.length > 0;
}
