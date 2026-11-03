import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { removeStaleClerkTokens } from "./DesktopStaleClerkTokens.ts";

it.effect("removes stale Clerk token files and keeps other state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-clerk-" });
    yield* fs.makeDirectory(path.join(stateDir, "clerk"));
    yield* fs.writeFileString(path.join(stateDir, "clerk", "clerk-tokens.json"), "{}");
    yield* fs.writeFileString(path.join(stateDir, "clerk-tokens.json"), "{}");
    yield* fs.writeFileString(path.join(stateDir, "desktop-settings.json"), "{}");

    yield* removeStaleClerkTokens(stateDir);
    yield* removeStaleClerkTokens(stateDir);

    assert.deepStrictEqual(yield* fs.readDirectory(stateDir), ["desktop-settings.json"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
