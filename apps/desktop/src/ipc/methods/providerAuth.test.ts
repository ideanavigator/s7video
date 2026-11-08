import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("../../app/CodexAuthCallback.ts", () => ({
  receiveCodexAuthCallback: async () => "http://localhost:1455/auth/callback?code=sign-in",
  cancelCodexAuthCallback: async () => undefined,
  CodexAuthCallbackError: class extends Error {},
}));

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { receiveProviderAuthCallback } from "./providerAuth.ts";

// S7V-074: returning from a sign-in the user started may bring s7video forward.
it.effect("the sign-in return reveals the window with a focus steal", () =>
  Effect.gen(function* () {
    const reveals: unknown[] = [];
    const window = {} as Electron.BrowserWindow;
    const callbackUrl = yield* receiveProviderAuthCallback
      .handler("https://auth.openai.com/oauth/authorize")
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronShell.ElectronShell)({ openExternal: () => Effect.succeed(true) }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              currentMainOrFirst: Effect.succeedSome(window),
              reveal: (_window, options) => Effect.sync(() => reveals.push(options)),
            }),
          ),
        ),
      );

    assert.strictEqual(callbackUrl, "http://localhost:1455/auth/callback?code=sign-in");
    assert.deepEqual(reveals, [{ steal: true }]);
  }),
);
