import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const layerShellEnvironment = (prepared = true) =>
  Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
    installIntoProcess: Effect.succeed(prepared),
    awaitDiscovery: Effect.succeed(prepared),
    updates: Stream.empty,
  });

const layerBackendConfiguration = (prepared = true) =>
  DesktopBackendConfiguration.layer.pipe(Layer.provide(layerShellEnvironment(prepared)));

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

function layerEnvironment(
  baseDir: string,
  options?: {
    readonly appPath?: string;
    readonly dirname?: string;
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
    readonly platform?: NodeJS.Platform;
    readonly resourcesPath?: string;
    readonly appVersion?: string;
    readonly processArch?: NodeJS.Architecture;
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  },
) {
  return DesktopEnvironment.layer({
    dirname: options?.dirname ?? "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: options?.platform ?? "darwin",
    processArch: options?.processArch ?? "x64",
    appVersion: options?.appVersion ?? "1.2.3",
    appPath: options?.appPath ?? "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: options?.resourcesPath ?? "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          S7VIDEO_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
          T3CODE_OTLP_TRACES_URL: options?.otlpTracesUrl,
          T3CODE_OTLP_METRICS_URL: options?.otlpMetricsUrl,
          T3CODE_OTLP_LOGS_URL: options?.otlpLogsUrl,
        }),
      ),
    ),
  );
}

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
  prepared = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        layerBackendConfiguration(prepared).pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(layerEnvironment(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it.effect("resolvePrimary produces a stable scoped bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const first = yield* configuration.resolvePrimary;
        const second = yield* configuration.resolvePrimary;

        assert.equal(first.executablePath, process.execPath);
        assert.deepEqual(first.args.slice(0, 3), [
          "--require",
          environment.compileCachePath,
          environment.backendEntryPath,
        ]);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.equal(first.env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING, "1");
        assert.isUndefined(first.env.T3CODE_PORT);
        assert.isUndefined(first.env.T3CODE_MODE);
        assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);

        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.host, "0.0.0.0");
        assert.equal(first.bootstrap.t3Home, environment.baseDir);
        assert.match(first.bootstrap.desktopBootstrapSecret ?? "", /^[0-9a-f]{64}$/i);
        assert.equal(
          second.bootstrap.desktopBootstrapSecret,
          first.bootstrap.desktopBootstrapSecret,
        );
        assert.equal(
          first.bootstrap.desktopBootstrapToken,
          currentDesktopBootstrapToken(
            first.bootstrap.desktopBootstrapSecret ?? "",
            yield* Clock.currentTimeMillis,
          ),
        );
        assert.equal(
          yield* configuration.currentBootstrapToken,
          first.bootstrap.desktopBootstrapToken,
        );
      }),
    ),
  );

  it.effect("resolvePrimary starts from server.asar", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const resourcesPath = path.join(baseDir, "resources");

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              layerEnvironment(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                platform: "win32",
                resourcesPath,
              }),
            ),
          ),
        ),
      );

      assert.equal(
        config.entryPath,
        path.join(resourcesPath, "server.asar/apps/server/dist/bin.mjs"),
      );
      assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the external packaged resource monitor over the copy inside the asar", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const resourcesPath = path.join(baseDir, "resources");
      const dirname = `${resourcesPath}/app.asar/apps/desktop/dist-electron`;
      const embeddedMonitorPath = `${resourcesPath}/app.asar/apps/desktop/prod-resources/resource-monitor/t3-resource-monitor`;
      const monitorPath = path.join(resourcesPath, "resource-monitor/t3-resource-monitor");
      yield* fileSystem.makeDirectory(
        `${resourcesPath}/app.asar/apps/desktop/prod-resources/resource-monitor`,
        { recursive: true },
      );
      yield* fileSystem.makeDirectory(`${resourcesPath}/resource-monitor`, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(embeddedMonitorPath, "embedded");
      yield* fileSystem.writeFileString(monitorPath, "binary");
      yield* fileSystem.chmod(monitorPath, 0o755);

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.resourceMonitorPath, monitorPath);
        assert.equal(config.bootstrap.desktopTelemetryFd, 4);
        assert.equal(config.bootstrap.desktopTelemetryControlFd, 5);
      }).pipe(
        Effect.provide(
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              layerEnvironment(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                dirname,
                isPackaged: true,
                resourcesPath,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
