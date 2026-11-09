import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["win32", "darwin"] as const)(
  "uses its own %s profile and never reads or copies T3 Code's",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "s7video-profile-" });
      const state = '{"os_crypt":{"encrypted_key":"t3-encrypted-key"}}';
      for (const upstream of ["t3code", "t3code-v2", "T3 Code (Alpha)"]) {
        yield* fs.makeDirectory(path.join(directory, upstream), { recursive: true });
        yield* fs.writeFileString(path.join(directory, upstream, "Local State"), state);
      }
      const production = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        isPackaged: true,
        platform,
      });
      const development = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: true,
        isPackaged: false,
        platform,
      });
      assert.equal(production, path.join(directory, "s7video"));
      assert.equal(development, path.join(directory, "s7video-dev"));
      assert.isFalse(yield* fs.exists(production));
      assert.isFalse(yield* fs.exists(path.join(production, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// S7V-073: the profile path the app actually uses, from its environment variables to the folder.
describe("dev profile per checkout", () => {
  const appData = "/Users/alice/Library/Application Support";
  const devServer = { VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" };
  const variable = "S7VIDEO_DESKTOP_DEV_PROFILE_DIR";

  const profilePath = (env: Record<string, string | undefined>, isPackaged = false) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return yield* resolveUserDataPath(environment);
    }).pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: "/Users/alice",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "0.0.22",
          appPath: "/Applications/s7video.app/Contents/Resources/app.asar",
          isPackaged,
          resourcesPath: "/Applications/s7video.app/Contents/Resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
          ),
        ),
      ),
    );

  it.effect("main checkout keeps the s7video-dev profile", () =>
    Effect.gen(function* () {
      // The dev runner never sets the variable outside a linked worktree, `--home-dir` or not.
      assert.equal(yield* profilePath(devServer), `${appData}/s7video-dev`);
      assert.equal(
        yield* profilePath({ ...devServer, S7VIDEO_HOME: "/repo/.t3" }),
        `${appData}/s7video-dev`,
      );
    }),
  );

  it.effect("linked worktree uses its own profile", () =>
    Effect.gen(function* () {
      const first = yield* profilePath({
        ...devServer,
        [variable]: "/work/s7video-a/.s7video/electron-profile",
      });
      const second = yield* profilePath({
        ...devServer,
        [variable]: "/work/s7video-b/.s7video/electron-profile",
      });
      assert.equal(first, "/work/s7video-a/.s7video/electron-profile");
      assert.equal(second, "/work/s7video-b/.s7video/electron-profile");
      assert.notEqual(first, second);
    }),
  );

  it.effect("packaged build ignores the variable", () =>
    Effect.gen(function* () {
      const stray = "/work/s7video-a/.s7video/electron-profile";
      assert.equal(yield* profilePath({ [variable]: stray }, true), `${appData}/s7video`);
      // Even with a dev server URL in its environment, a packaged app never takes the folder.
      assert.equal(
        yield* profilePath({ ...devServer, [variable]: stray }, true),
        `${appData}/s7video-dev`,
      );
    }),
  );

  it.effect("empty or blank variable is ignored", () =>
    Effect.gen(function* () {
      assert.equal(yield* profilePath({ ...devServer, [variable]: "" }), `${appData}/s7video-dev`);
      assert.equal(
        yield* profilePath({ ...devServer, [variable]: "   " }),
        `${appData}/s7video-dev`,
      );
    }),
  );

  it.effect("worktree home with spaces in the path", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* profilePath({
          ...devServer,
          [variable]: "  /Users/alice/My Work/s7video b/.s7video/electron-profile  ",
        }),
        "/Users/alice/My Work/s7video b/.s7video/electron-profile",
      );
    }),
  );
});
