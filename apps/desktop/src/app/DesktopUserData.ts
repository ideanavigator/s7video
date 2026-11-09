import { brandIdentityFor } from "@t3tools/shared/brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

/**
 * s7video's own Electron profile. T3 Code's profiles are never read or copied (S7V-003 AC-7).
 *
 * A dev app started from a linked git worktree gets the profile folder the dev runner names in
 * `S7VIDEO_DESKTOP_DEV_PROFILE_DIR`, so its single-instance lock and storage are its own (S7V-073).
 * The main checkout never gets that variable, and packaged builds ignore it.
 */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly devProfileDirectory?: Option.Option<string>;
  }) {
    const path = yield* Path.Path;
    const devProfileDirectory =
      input.isDevelopment && !input.isPackaged
        ? (input.devProfileDirectory ?? Option.none())
        : Option.none();
    return Option.match(devProfileDirectory, {
      onNone: () =>
        path.join(input.appDataDirectory, brandIdentityFor(input.isDevelopment).userDataDirName),
      onSome: (directory) => path.resolve(directory),
    });
  },
);
