import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Deletes Clerk session tokens that T3 Code builds stored under the state directory. */
export const removeStaleClerkTokens = Effect.fn("desktop.removeStaleClerkTokens")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const stalePath of [
    path.join(stateDir, "clerk"),
    path.join(stateDir, "clerk-tokens.json"),
  ]) {
    yield* fs
      .remove(stalePath, { recursive: true, force: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove stale Clerk tokens", { cause }),
        ),
      );
  }
});
