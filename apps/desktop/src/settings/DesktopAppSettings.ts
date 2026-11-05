import {
  DesktopServerExposureModeSchema,
  DesktopUpdateChannelSchema,
  type DesktopServerExposureMode,
  type DesktopUpdateChannel,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";

export interface DesktopSettings {
  readonly localEnvironmentEnabled: boolean;
  readonly linuxPasswordStore: LinuxPasswordStorePreference;
  readonly mainWindowBounds: DesktopWindowBounds | null;
  readonly mainWindowMaximized: boolean;
  readonly serverExposureMode: DesktopServerExposureMode;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

const MIN_MAIN_WINDOW_SIZE = {
  width: 840,
  height: 620,
} as const;
export const DesktopWindowBoundsSchema = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.width)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.height)),
});
export type DesktopWindowBounds = typeof DesktopWindowBoundsSchema.Type;
export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  localEnvironmentEnabled: true,
  linuxPasswordStore: DEFAULT_LINUX_PASSWORD_STORE,
  mainWindowBounds: null,
  mainWindowMaximized: false,
  serverExposureMode: "local-only",
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
};

const DesktopWindowBoundsDocument = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

const DesktopSettingsDocument = Schema.Struct({
  localEnvironmentEnabled: Schema.optionalKey(Schema.Boolean),
  linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  mainWindowBounds: Schema.optionalKey(Schema.NullOr(DesktopWindowBoundsDocument)),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
  serverExposureMode: Schema.optionalKey(DesktopServerExposureModeSchema),
  updateChannel: Schema.optionalKey(DesktopUpdateChannelSchema),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
});

type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeEffect(DesktopSettingsJson);
const decodeDesktopWindowBounds = Schema.decodeUnknownOption(DesktopWindowBoundsSchema);
const desktopWindowBoundsEquivalence = Schema.toEquivalence(DesktopWindowBoundsSchema);

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

const DesktopSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "resolve-symlink",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);
type DesktopSettingsWriteOperation = typeof DesktopSettingsWriteOperation.Type;

export class DesktopSettingsWriteError extends Schema.TaggedError<DesktopSettingsWriteError>()(
  "DesktopSettingsWriteError",
  {
    operation: DesktopSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  {
    readonly load: Effect.Effect<DesktopSettings>;
    readonly get: Effect.Effect<DesktopSettings>;
    readonly setLocalEnvironmentEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setMainWindowBounds: (
      bounds: DesktopWindowBounds,
      isMaximized: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setServerExposureMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setUpdateChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  }
>()("@t3tools/desktop/settings/DesktopAppSettings") {}

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: desktopUpdateChannelOf(appVersion),
  };
}

export function normalizeMainWindowBounds(value: unknown): DesktopWindowBounds | null {
  return Option.getOrNull(decodeDesktopWindowBounds(value));
}

function normalizeDesktopSettingsDocument(
  parsed: DesktopSettingsDocument,
  appVersion: string,
): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);
  const mainWindowBounds = normalizeMainWindowBounds(parsed.mainWindowBounds);
  const parsedUpdateChannel = Option.fromNullishOr(parsed.updateChannel);
  const isLegacySettings = parsed.updateChannelConfiguredByUser === undefined;
  const updateChannelConfiguredByUser =
    parsed.updateChannelConfiguredByUser === true ||
    (isLegacySettings && Option.contains(parsedUpdateChannel, "nightly"));

  return {
    localEnvironmentEnabled: parsed.localEnvironmentEnabled !== false,
    linuxPasswordStore: normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore),
    mainWindowBounds,
    mainWindowMaximized: mainWindowBounds !== null && parsed.mainWindowMaximized === true,
    serverExposureMode:
      parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
    updateChannel: updateChannelConfiguredByUser
      ? Option.getOrElse(parsedUpdateChannel, () => defaultSettings.updateChannel)
      : defaultSettings.updateChannel,
    updateChannelConfiguredByUser,
  };
}

function toDesktopSettingsDocument(
  settings: DesktopSettings,
  defaults: DesktopSettings,
): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};

  if (settings.localEnvironmentEnabled !== defaults.localEnvironmentEnabled) {
    document.localEnvironmentEnabled = settings.localEnvironmentEnabled;
  }

  if (settings.linuxPasswordStore !== defaults.linuxPasswordStore) {
    document.linuxPasswordStore = settings.linuxPasswordStore;
  }
  if (settings.mainWindowBounds !== null) {
    document.mainWindowBounds = settings.mainWindowBounds;
  }
  if (settings.mainWindowMaximized) {
    document.mainWindowMaximized = true;
  }
  if (settings.serverExposureMode !== defaults.serverExposureMode) {
    document.serverExposureMode = settings.serverExposureMode;
  }
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  if (settings.updateChannelConfiguredByUser !== defaults.updateChannelConfiguredByUser) {
    document.updateChannelConfiguredByUser = settings.updateChannelConfiguredByUser;
  }

  return document;
}

function setServerExposureMode(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

function setMainWindowBounds(
  settings: DesktopSettings,
  bounds: DesktopWindowBounds,
  isMaximized: boolean,
): DesktopSettings {
  return settings.mainWindowBounds !== null &&
    desktopWindowBoundsEquivalence(settings.mainWindowBounds, bounds) &&
    settings.mainWindowMaximized === isMaximized
    ? settings
    : {
        ...settings,
        mainWindowBounds: bounds,
        mainWindowMaximized: isMaximized,
      };
}

function setUpdateChannel(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === requestedChannel
    ? settings
    : {
        ...settings,
        updateChannel: requestedChannel,
        updateChannelConfiguredByUser: true,
      };
}

function setLocalEnvironmentEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.localEnvironmentEnabled === enabled
    ? settings
    : { ...settings, localEnvironmentEnabled: enabled };
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  appVersion: string,
): Effect.Effect<DesktopSettings> {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaultSettings),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map((parsed) => normalizeDesktopSettingsDocument(parsed, appVersion)),
            Effect.orElseSucceed(() => defaultSettings),
          ),
      }),
    ),
  );
}

const writeSettings = Effect.fn("desktop.settings.writeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: DesktopSettings;
  readonly defaultSettings: DesktopSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopSettingsWriteError> {
  const targetPath = yield* resolveSymlinkTarget(input.settingsPath).pipe(
    Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    Effect.provideService(Path.Path, input.path),
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "resolve-symlink",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  const directory = input.path.dirname(targetPath);
  const tempPath = `${targetPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeDesktopSettingsJson(
    toDesktopSettingsDocument(input.settings, input.defaultSettings),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "replace-settings-file",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);

  const persist = (
    update: (settings: DesktopSettings) => DesktopSettings,
  ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
    SynchronizedRef.modifyEffect(settingsRef, (settings) => {
      const nextSettings = update(settings);
      if (nextSettings === settings) {
        return Effect.succeed([settingsChange(settings, false), settings] as const);
      }

      return crypto.randomUUIDv4().pipe(
        Effect.map((uuid) => uuid.replace(/-/g, "")),
        Effect.mapError(
          (cause) =>
            new DesktopSettingsWriteError({
              operation: "create-temporary-file-name",
              path: environment.desktopSettingsPath,
              cause,
            }),
        ),
        Effect.flatMap((suffix) =>
          writeSettings({
            fileSystem,
            path,
            settingsPath: environment.desktopSettingsPath,
            settings: nextSettings,
            defaultSettings: environment.defaultDesktopSettings,
            suffix,
          }),
        ),
        Effect.as([settingsChange(nextSettings, true), nextSettings] as const),
      );
    });

  return DesktopAppSettings.of({
    get: SynchronizedRef.get(settingsRef),
    load: Effect.gen(function* () {
      const settings = yield* readSettings(
        fileSystem,
        environment.desktopSettingsPath,
        environment.appVersion,
      );
      return yield* SynchronizedRef.setAndGet(settingsRef, settings);
    }).pipe(Effect.withSpan("desktop.settings.load")),
    setMainWindowBounds: Effect.fn("desktop.settings.setMainWindowBounds")(
      function* (bounds, isMaximized) {
        yield* Effect.annotateCurrentSpan({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized,
        });

        return yield* persist((settings) => setMainWindowBounds(settings, bounds, isMaximized));
      },
    ),
    setServerExposureMode: Effect.fn("desktop.settings.setServerExposureMode")(function* (mode) {
      yield* Effect.annotateCurrentSpan({ mode });

      return yield* persist((settings) => setServerExposureMode(settings, mode));
    }),
    setUpdateChannel: Effect.fn("desktop.settings.setUpdateChannel")(function* (channel) {
      yield* Effect.annotateCurrentSpan({ channel });

      return yield* persist((settings) => setUpdateChannel(settings, channel));
    }),
    setLocalEnvironmentEnabled: Effect.fn("desktop.settings.setLocalEnvironmentEnabled")(
      function* (enabled) {
        yield* Effect.annotateCurrentSpan({ enabled });

        return yield* persist((settings) => setLocalEnvironmentEnabled(settings, enabled));
      },
    ),
  });
});

export const layer = Layer.effect(DesktopAppSettings, make);

export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [
            {
              settings: nextSettings,
              changed: nextSettings !== settings,
            },
            nextSettings,
          ] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setMainWindowBounds: Effect.fn("DesktopAppSettings.setMainWindowBounds")(
          function (bounds, isMaximized) {
            return update((settings) => setMainWindowBounds(settings, bounds, isMaximized));
          },
        ),
        setServerExposureMode: Effect.fn("DesktopAppSettings.setServerExposureMode")(
          function (mode) {
            return update((settings) => setServerExposureMode(settings, mode));
          },
        ),
        setUpdateChannel: Effect.fn("DesktopAppSettings.setUpdateChannel")(function (channel) {
          return update((settings) => setUpdateChannel(settings, channel));
        }),
        setLocalEnvironmentEnabled: Effect.fn("DesktopAppSettings.setLocalEnvironmentEnabled")(
          function (enabled) {
            return update((settings) => setLocalEnvironmentEnabled(settings, enabled));
          },
        ),
      });
    }),
  );
