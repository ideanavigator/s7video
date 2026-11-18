import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);

it.layer(NodeServices.layer)("resolveManagedCodexHomeLayout", (it) => {
  describe("with the settings the welcome wizard saves", () => {
    it.effect.each(["codex", "codex-personal"])(
      "keeps %s's Codex home in the data folder and leaves the user's home untouched",
      (instance) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fs.makeTempDirectoryScoped({ prefix: "codex-user-home-" });
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "codex-state-" });
          const layout = yield* resolveManagedCodexHomeLayout(
            stateDir,
            ProviderInstanceId.make(instance),
            decodeSettings({ enabled: true, setupMode: "managed" }),
          ).pipe(Effect.provideService(HostProcess.HomeDirectory, userHome));
          yield* materializeCodexShadowHome(layout);

          const codexHome = layout.effectiveHomePath ?? layout.sharedHomePath;
          expect(layout.sharedHomePath.startsWith(`${stateDir}${path.sep}`)).toBe(true);
          expect(codexHome.startsWith(`${stateDir}${path.sep}`)).toBe(true);
          expect(yield* fs.readDirectory(userHome)).toEqual([]);
        }),
    );
  });

  it.effect("still uses a CODEX_HOME path the user set", () =>
    Effect.gen(function* () {
      const layout = yield* resolveManagedCodexHomeLayout(
        "/data/userdata",
        ProviderInstanceId.make("codex"),
        decodeSettings({ setupMode: "managed", homePath: "/custom/codex-home" }),
      ).pipe(Effect.provideService(HostProcess.HomeDirectory, "/home/user"));
      expect(layout).toMatchObject({
        mode: "direct",
        sharedHomePath: "/custom/codex-home",
        effectiveHomePath: "/custom/codex-home",
      });
    }),
  );
});
