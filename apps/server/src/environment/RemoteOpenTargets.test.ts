// @effect-diagnostics nodeBuiltinImport:off -- replace the native OS lookup and sync its ESM bindings.
import * as NodeModule from "node:module";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";

afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
});

const layerNet = (input: { readonly ipv4: boolean; readonly ipv6: boolean }) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: (_port, host) => Effect.succeed(host === "::1" ? input.ipv6 : input.ipv4),
    reserveLoopbackPort: () => Effect.succeed(40_000),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });

const resolveTargets = (input: {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean };
  readonly hostname: string;
  readonly username?: string | null;
}) => {
  const resolve = Effect.flatMap(RemoteOpenTargets.RemoteOpenTargets, (service) =>
    service.resolveTargets(),
  ).pipe(
    Effect.provideService(HostProcess.Hostname, input.hostname),
    Effect.provide(RemoteOpenTargets.layer.pipe(Layer.provide(layerNet(input.sshd)))),
  );

  return input.username === undefined
    ? resolve
    : resolve.pipe(Effect.provideService(HostProcess.Username, input.username));
};

describe("RemoteOpenTargets", () => {
  it.effect("advertises nothing when no sshd accepts", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        hostname: "bb-1",
        username: "t3-user",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("accepts an sshd bound to IPv6 loopback only", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: true },
        hostname: "bb-1.example.com",
        username: "t3-user",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local", username: "t3-user" }]);
    }),
  );

  it.effect("leaves the username out when it is unknown", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: false },
        hostname: "bb-1",
        username: null,
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );
});
