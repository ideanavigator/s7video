import { makeSecretProviderDefinitionRegistry } from "@t3tools/secret-provider-core/shared/definition";

// s7video ships no external secret providers; see docs/FORK.md.
export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([]);
