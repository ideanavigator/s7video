import { assert, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";

import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";

const source = (reference: string) => ({
  provider: SecretProviderId.make("homelab"),
  reference,
});

const secretsByReference = new Map([["bitbucket#token", "bb_from_provider"]]);

const hosts = {
  bitbucket: { email: "me@example.test", accessToken: source("bitbucket#token") },
  gitcafe: { token: source("missing#token") },
  github: { tokens: { "github.com": "ghp_literal" } },
};

function countingResolver() {
  const reads: Array<string> = [];
  const resolver = SecretResolver.SecretResolver.of({
    read: (references) =>
      Effect.sync(() =>
        references.map((reference) => {
          reads.push(reference.reference);
          return secretsByReference.get(reference.reference);
        }),
      ),
    invalidate: () => Effect.void,
  });
  return { reads, resolver };
}

it.effect("leaves the resolver unused for a kind that holds no reference", () =>
  Effect.gen(function* () {
    const { reads, resolver } = countingResolver();
    const resolved = yield* resolveSourceControlHostSecrets(resolver, hosts, "github");
    assert.strictEqual(resolved, hosts);
    assert.deepEqual(reads, []);
  }),
);
