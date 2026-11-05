import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopCliShim from "../app/DesktopCliShim.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

export class DesktopBackendObservabilitySettingsReadError extends Schema.TaggedError<DesktopBackendObservabilitySettingsReadError>()(
  "DesktopBackendObservabilitySettingsReadError",
  {
    settingsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read persisted backend observability settings at ${this.settingsPath}.`;
  }
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolvePrimaryLabel: Effect.Effect<string>;
    readonly currentBootstrapToken: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
  readonly otlpLogsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
  otlpLogsUrl: Option.none(),
};

const DESKTOP_BACKEND_ENV_NAMES = [
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_HOST",
  "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
] as const;

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

const logBackendObservabilitySettingsReadFailure = (
  settingsPath: string,
  cause: PlatformError.PlatformError,
) => {
  const error = new DesktopBackendObservabilitySettingsReadError({ settingsPath, cause });
  return Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-backend-configuration",
      error,
    }),
  );
};

function resourceMonitorBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

const resolveResourceMonitorPath = Effect.fn(
  "desktop.backendConfiguration.resolveResourceMonitorPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName = resourceMonitorBinaryName(environment.platform);
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/release",
          binaryName,
        ),
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/debug",
          binaryName,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "resource-monitor", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("resource-monitor", binaryName),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

const readPersistedBackendObservabilitySettings = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : logBackendObservabilitySettingsReadFailure(environment.serverSettingsPath, cause).pipe(
              Effect.as(Option.none()),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
    otlpLogsUrl: Option.fromNullishOr(parsed.otlpLogsUrl),
  };
});

const readBackendObservabilitySettings = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const persisted = yield* readPersistedBackendObservabilitySettings;
  return {
    otlpTracesUrl: Option.orElse(environment.otlpTracesUrl, () => persisted.otlpTracesUrl),
    otlpMetricsUrl: Option.orElse(environment.otlpMetricsUrl, () => persisted.otlpMetricsUrl),
    otlpLogsUrl: Option.orElse(environment.otlpLogsUrl, () => persisted.otlpLogsUrl),
  } satisfies BackendObservabilitySettings;
});

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly bootstrapSecret: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

const buildObservabilityFragment = (observabilitySettings: BackendObservabilitySettings) => ({
  ...Option.match(observabilitySettings.otlpTracesUrl, {
    onNone: () => ({}),
    onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
  }),
  ...Option.match(observabilitySettings.otlpMetricsUrl, {
    onNone: () => ({}),
    onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
  }),
  ...Option.match(observabilitySettings.otlpLogsUrl, {
    onNone: () => ({}),
    onSome: (otlpLogsUrl) => ({ otlpLogsUrl }),
  }),
});

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
      readonly cliPath: Option.Option<string>;
      readonly shellEnvironmentPrepared: boolean;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    DesktopEnvironment.DesktopEnvironment | DesktopServerExposure.DesktopServerExposure
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      desktopBootstrapSecret: input.bootstrapSecret,
      shellEnvironmentPrepared: input.shellEnvironmentPrepared,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      desktopBrowserFd: 6,
      desktopBrowserControlFd: 7,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      // Packaged builds have a separate cache; --require prevents cache settings leaking to provider subprocesses.
      args: [
        ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
        environment.backendEntryPath,
        "--bootstrap-fd",
        "3",
      ],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        S7VIDEO_CLI_PATH: Option.getOrUndefined(input.cliPath),
      },
      extendEnv: true,
      bootstrap,
      bootstrapDelivery: "fd3",
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const crypto = yield* Crypto.Crypto;
  // Random generation yields; serialize it so concurrent backends cannot capture distinct bootstrap secrets.
  const secretRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapSecret = SynchronizedRef.modifyEffect(secretRef, (current) =>
    Option.match(current, {
      onSome: (secret) => Effect.succeed([secret, current] as const),
      onNone: () =>
        crypto.randomBytes(32).pipe(
          Effect.map((bytes) => {
            const secret = Hex.encode(bytes);
            return [secret, Option.some(secret)] as const;
          }),
        ),
    }),
  );

  const sharedInputs = Effect.gen(function* () {
    const bootstrapSecret = yield* getOrCreateBootstrapSecret;
    const bootstrapToken = currentDesktopBootstrapToken(
      bootstrapSecret,
      yield* Clock.currentTimeMillis,
    );
    const observabilitySettings = yield* readBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return {
      bootstrapToken,
      bootstrapSecret,
      observabilitySettings,
    } satisfies SharedBootstrapInput;
  });

  const buildPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const cliPath = yield* DesktopCliShim.install.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const shellEnvironmentPrepared = yield* shellEnvironment.installIntoProcess;
    return yield* resolvePrimaryStartConfig({
      ...shared,
      resourceMonitorPath,
      cliPath,
      shellEnvironmentPrepared,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
    );
  });

  const currentBootstrapToken = Effect.gen(function* () {
    const secret = yield* getOrCreateBootstrapSecret;
    return currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
  });

  return DesktopBackendConfiguration.of({
    currentBootstrapToken,
    resolvePrimary: buildPrimaryConfig.pipe(
      Effect.withSpan("desktop.backendConfiguration.resolvePrimary"),
    ),
    resolvePrimaryLabel: Effect.succeed("Local environment"),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
