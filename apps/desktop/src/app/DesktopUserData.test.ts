import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
        platform,
      });
      const development = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: true,
        platform,
      });
      assert.equal(production, path.join(directory, "s7video"));
      assert.equal(development, path.join(directory, "s7video-dev"));
      assert.isFalse(yield* fs.exists(production));
      assert.isFalse(yield* fs.exists(path.join(production, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
