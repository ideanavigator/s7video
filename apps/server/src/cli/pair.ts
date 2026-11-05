import { BRAND } from "@t3tools/shared/brand";
import {
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  isProcessAlive,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  buildPairingUrl,
  isLoopbackHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import { authScopesFlag } from "./authScopes.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PAIR_PROBE_TIMEOUT = Duration.millis(2_500);

export type PairStateVariant = "userdata" | "dev";

// Only devUrl's presence selects dev state; its value is unused.
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

export class NoRunningServerError extends Schema.TaggedError<NoRunningServerError>()(
  "NoRunningServerError",
  {
    checkedStatePaths: Schema.Array(Schema.String),
    inLinkedWorktree: Schema.Boolean,
  },
) {
  override get message(): string {
    return [
      `No running ${BRAND.app.productName} server found.`,
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      ...(this.inLinkedWorktree
        ? ["In a linked worktree, pass --base-dir to pair with a server outside it."]
        : []),
      `Start one with \`${BRAND.app.cliName} serve\`.`,
    ].join("\n");
  }
}

export class IncompatibleServerProtocolError extends Schema.TaggedError<IncompatibleServerProtocolError>()(
  "IncompatibleServerProtocolError",
  { serverVersion: Schema.String, serverProtocolVersion: Schema.Number },
) {
  override get message(): string {
    return [
      `The running ${BRAND.app.productName} server (${this.serverVersion}) speaks orchestration protocol ${String(this.serverProtocolVersion)}, but this CLI speaks protocol ${String(ORCHESTRATION_PROTOCOL_VERSION)}.`,
      `Pair with the matching CLI instead: \`${BRAND.app.cliName} pair\` from ${BRAND.app.cliName} ${this.serverVersion}.`,
    ].join("\n");
  }
}

const resolveDirectPairingBaseUrl = (state: PersistedServerRuntimeState): string =>
  state.devUrl ??
  resolveHeadlessConnectionString(state.host, state.port, {
    privateNetworkOnly: state.privateNetworkOnly,
  });

const formatPairOutput = (input: {
  readonly serverLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly notes: ReadonlyArray<string>;
}): string =>
  [
    `Pairing with ${input.serverLabel} (${input.origin}).`,
    "",
    renderTerminalQrCode(input.pairingUrl),
    "",
    `Pairing URL: ${input.pairingUrl}`,
    `App link: ${buildPairingAppLink(input.pairingUrl)}`,
    `Token: ${input.token}`,
    `Expires: ${DateTime.formatIso(input.expiresAt)}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");

type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

const probeEnvironmentDescriptor: (
  baseUrl: string,
) => Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> = Effect.fn(
  "pair.probeEnvironmentDescriptor",
)(
  function* (baseUrl: string) {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PAIR_PROBE_TIMEOUT),
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Gateway errors identify stale proxy mappings that pairing may repair.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  },
  Effect.catch((outcome) => Effect.succeed(outcome)),
);

interface DiscoveredPairTarget {
  readonly baseDir: string;
  readonly variant: PairStateVariant;
  readonly state: PersistedServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

const discoverPairTarget = Effect.fn("pair.discoverPairTarget")(function* (
  explicitBaseDir: string | undefined,
) {
  const bases: Array<string> = [];
  let inLinkedWorktree = false;
  if (explicitBaseDir !== undefined && explicitBaseDir.trim().length > 0) {
    bases.push(yield* resolveBaseDir(explicitBaseDir));
  } else {
    // Same precedence as dev-runner: inside a linked worktree only its own
    // `.t3` counts. Minting opens the target database with this checkout's
    // migrations, so falling back to the shared home could migrate the live
    // install with unreleased schema.
    const worktreeHome = yield* resolveWorktreeT3Home(yield* HostProcess.WorkingDirectory);
    if (worktreeHome !== undefined) {
      bases.push(worktreeHome);
      inLinkedWorktree = true;
    } else {
      const envHome = yield* Config.String("S7VIDEO_HOME").pipe(Config.option);
      bases.push(yield* resolveBaseDir(Option.getOrUndefined(envHome)));
    }
  }

  const checkedStatePaths: Array<string> = [];
  for (const baseDir of new Set(bases)) {
    for (const variant of ["userdata", "dev"] as const) {
      const derivedPaths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
        {},
      );
      const statePath = derivedPaths.serverRuntimeStatePath;
      checkedStatePaths.push(statePath);
      const state = yield* readPersistedServerRuntimeState(statePath);
      if (Option.isNone(state)) {
        continue;
      }
      // A dead server's port may be reused; do not mint tokens in its old database for another server.
      if (!isProcessAlive(state.value.pid)) {
        continue;
      }
      const probed = yield* probeEnvironmentDescriptor(state.value.origin);
      if (probed._tag !== "descriptor") {
        continue;
      }
      return {
        baseDir,
        variant,
        state: state.value,
        descriptor: probed.descriptor,
      } satisfies DiscoveredPairTarget;
    }
  }
  return yield* new NoRunningServerError({ checkedStatePaths, inLinkedWorktree });
});

/** Use the discovered state directory, independent of ambient config variables. */
const makePairServerConfig = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly logLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
}) {
  const { baseDir, variant, state } = input.target;
  // Worktree dev servers can use `userdata`; only the recorded devUrl marks a dev server.
  const devUrl = state.devUrl !== undefined ? new URL(state.devUrl) : undefined;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(
    baseDir,
    variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
    {},
  );
  return ServerConfig.make({
    logLevel: input.logLevel,
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: state.port,
    host: state.host,
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopBrowserFd: undefined,
    desktopBrowserControlFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  });
});

const mintPairingLink = Effect.fn("pair.mintPairingLink")(function* (input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly ttl: Option.Option<Duration.Duration>;
  readonly label: Option.Option<string>;
}) {
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* environmentAuth.createPairingLink({
      scopes: input.scopes,
      subject: "one-time-token",
      label: Option.getOrElse(input.label, () => `${BRAND.app.cliName} pair`),
      ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
    });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(input.config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, input.config.logLevel)),
      ),
    ),
  );
});

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "Token TTL, for example `5m`, `1h`, or `15 minutes`. Defaults to 5 minutes.",
  ),
  Flag.optional,
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional label shown in the server's connections list."),
  Flag.optional,
);

export const pairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
}).pipe(
  Command.withDescription(
    `Mint a pairing token for a running ${BRAND.app.productName} server and print it as a QR code.`,
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);

      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));
      // Each protocol keeps auth in its own database, so a token minted here
      // for another protocol's server would never be accepted by it. Refuse
      // before any local layer opens (and migrates) that database.
      const serverProtocolVersion = target.descriptor.orchestrationProtocolVersion ?? 1;
      if (serverProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION) {
        return yield* new IncompatibleServerProtocolError({
          serverVersion: target.descriptor.serverVersion,
          serverProtocolVersion,
        });
      }

      const notes: Array<string> = [];
      const pairingBaseUrl = resolveDirectPairingBaseUrl(target.state);
      if (isLoopbackHost(new URL(pairingBaseUrl).hostname)) {
        notes.push(
          `This URL is only reachable from this machine. To reach it from your other devices, run \`${BRAND.app.cliName} up\`.`,
        );
      } else if (target.state.privateNetworkOnly) {
        notes.push("This URL works only from this machine's local network.");
      }
      if (target.variant === "dev" && target.state.devUrl === undefined) {
        notes.push(
          "This dev server did not record its web URL; restart it so pairing can go through the web origin.",
        );
      }
      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* mintPairingLink({
        config,
        scopes: flags.scopes,
        ttl: flags.ttl,
        label: flags.label,
      });
      const pairingUrl = buildPairingUrl(pairingBaseUrl, issued.credential);

      yield* Console.log(
        formatPairOutput({
          serverLabel: target.descriptor.label,
          origin: target.state.origin,
          pairingUrl,
          token: issued.credential,
          expiresAt: issued.expiresAt,
          notes,
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
