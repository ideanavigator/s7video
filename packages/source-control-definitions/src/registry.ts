import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";

// s7video ships no source-control hosts; see docs/FORK.md.
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry([]);
