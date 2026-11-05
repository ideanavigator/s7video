import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import type { SecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";

/** In the shared registry's order. */
export const BUILT_IN_SECRET_PROVIDER_DRIVER_LIST: ReadonlyArray<SecretProviderDriver> = [];

export const secretProviderDefinitions = builtInSecretProviderDefinitions;
