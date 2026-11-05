import type { ManagedPolicyDocument } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as ManagedLimits from "./managedLimits.ts";
import * as ManagedPolicy from "./ManagedPolicy.ts";

const policy = (limits?: ManagedPolicyDocument["limits"]) => ({
  document: {
    schemaVersion: 1 as const,
    organization: "Example Corp",
    ...(limits === undefined ? {} : { limits }),
  },
});

const desktopAndLocal = policy({ clients: ["desktop", "local-browser"] });

it.effect("refuses to listen on a non-loopback host when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(desktopAndLocal, {
      authPolicy: "remote-reachable",
      host: "0.0.0.0",
    }).pipe(Effect.flip);
    assert.equal(
      error.message,
      "Example Corp's policy does not allow remote clients, so the server cannot listen on 0.0.0.0.",
    );
  }),
);

it.effect("binds only the loopback address it approved when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const bind = (
      host: string | undefined,
      policy: { readonly document: ManagedPolicyDocument | undefined } = desktopAndLocal,
    ) =>
      ManagedLimits.checkServerReachability(policy, {
        authPolicy: EnvironmentAuthPolicy.resolveServerAuthPolicy({ mode: "web", host }),
        host,
      });
    // Node listens on every interface for an empty host, and a name resolves through DNS.
    for (const host of ["", "127.office.example", "127.0.0.1e0", "0.0.0.0"]) {
      const error = yield* bind(host).pipe(Effect.flip);
      assert.include(error.message, "does not allow remote clients", host);
    }
    for (const [host, address] of [
      [undefined, "127.0.0.1"],
      ["localhost", "127.0.0.1"],
      ["127.0.0.2", "127.0.0.2"],
      ["[::1]", "::1"],
    ] as const) {
      assert.equal(yield* bind(host), address);
    }
    const service = yield* ManagedLimits.checkServerReachability(desktopAndLocal, {
      authPolicy: "remote-reachable",
      host: "0.0.0.0",
      privateNetworkOnly: true,
    }).pipe(Effect.flip);
    assert.include(service.message, "set T3CODE_HOST=127.0.0.1 in its service.env");
    assert.equal(yield* bind("localhost", { document: undefined }), "localhost");
    assert.equal(yield* bind(undefined, { document: undefined }), "127.0.0.1");
  }),
);

it.effect("refuses an auth policy the clients list leaves out", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(policy({ clients: ["desktop"] }), {
      authPolicy: "loopback-browser",
      host: undefined,
    }).pipe(Effect.flip);
    assert.equal(error.message, "Example Corp's policy does not allow browsers on this machine.");
  }),
);

it.effect("refuses unsafe-no-auth under any policy file, even one without limits", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(policy(), {
      authPolicy: "unsafe-no-auth",
      host: undefined,
    }).pipe(Effect.flip);
    assert.include(error.message, "without authentication");
    assert.isTrue(ManagedLimits.allowsAuthPolicy({ document: undefined }, "unsafe-no-auth"));
  }),
);

it.effect("allows the clients the policy lists", () =>
  ManagedLimits.checkServerReachability(policy({ clients: ["remote"] }), {
    authPolicy: "remote-reachable",
    host: "0.0.0.0",
  }),
);

it.effect("tells clients Connect is off when the policy leaves out remote clients", () =>
  Effect.gen(function* () {
    const managed = yield* ManagedPolicy.fromDocument("/test/policy.json", {
      ...desktopAndLocal.document,
    });
    assert.deepEqual(managed.summary?.limits, {
      clients: ["desktop", "local-browser"],
      connect: false,
    });
    assert.isTrue(ManagedLimits.allowsConnect(policy({ clients: ["remote"] })));
    assert.isFalse(ManagedLimits.allowsConnect(policy({ connect: false })));
  }),
);
