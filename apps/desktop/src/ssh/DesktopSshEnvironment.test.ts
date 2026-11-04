import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { REMOTE_ENVIRONMENTS_DISABLED_MESSAGE } from "@t3tools/shared/remoteEnvironments";
import * as NetService from "@t3tools/shared/Net";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

const target = { alias: "my-mac", hostname: "localhost", username: null, port: null };

it.effect("refuses to launch or stop an SSH environment while remote environments are off", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const manager = Layer.mock(SshTunnel.SshEnvironmentManager, {
      ensureEnvironment: () => Effect.sync(() => void calls.push("ensure")).pipe(Effect.die),
      disconnectEnvironment: () =>
        Effect.sync(() => void calls.push("disconnect")).pipe(Effect.die),
    });
    const ssh = yield* DesktopSshEnvironment.make().pipe(
      Effect.provide(
        Layer.mergeAll(
          manager,
          Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
          Layer.mock(NetService.NetService, {}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no HTTP")),
          ),
        ),
      ),
    );

    const ensure = yield* ssh.ensureEnvironment(target).pipe(Effect.flip);
    const disconnect = yield* ssh.disconnectEnvironment(target).pipe(Effect.flip);

    assert.equal(ensure.message, REMOTE_ENVIRONMENTS_DISABLED_MESSAGE);
    assert.equal(disconnect.message, REMOTE_ENVIRONMENTS_DISABLED_MESSAGE);
    // Neither the launch script nor the stop script (which kills a recorded PID) ran.
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
