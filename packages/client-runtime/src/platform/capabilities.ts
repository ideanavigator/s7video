import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

/**
 * A random id this client keeps across launches. Environments it connects to
 * record its hash, so two environments opened from one device share an owner
 * in analytics even when nobody is signed in.
 */
export class AnalyticsDevice extends Context.Reference<{
  readonly id: Effect.Effect<Option.Option<string>>;
}>("@t3tools/client-runtime/platform/capabilities/AnalyticsDevice", {
  defaultValue: () => ({ id: Effect.succeedNone }),
}) {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
  }
>()("@t3tools/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}
