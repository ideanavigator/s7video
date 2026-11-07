// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Reads the S7V-024 git edit history once for import into `.s7history/` (S7V-051 AC-7); it never
 * writes the old file or refs. Git access comes in as parameters so it is only used when S7V-052's
 * no-spawn probe finds a real git; until then the server uses `layerNone`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CACHE_DIR, EDIT_FILE, PROJECT_FILE, projectFileContents } from "./EditProjectLayout.ts";

const LEGACY_HISTORY_FILE = "edit-history.json";

const LegacyState = Schema.Struct({
  version: Schema.Literal(1),
  nextSeq: Schema.Int,
  highestRevision: Schema.Int,
  cursor: Schema.Int,
  entries: Schema.Array(
    Schema.Struct({ seq: Schema.Int, revision: Schema.Int, ref: Schema.String }),
  ),
  knownEdit: Schema.optionalKey(Schema.String),
});
const decodeLegacyState = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyState));

export interface LegacyHistoryStep {
  readonly seq: number;
  readonly revision: number;
  readonly editJson: string;
  readonly projectJson: string;
}

/** The old history as texts, ready to save as objects. `cursor` indexes `steps`. */
export interface LegacyHistory {
  readonly steps: ReadonlyArray<LegacyHistoryStep>;
  readonly cursor: number;
  readonly nextSeq: number;
  readonly highestRevision: number;
  readonly knownEdit?: string;
}

/** Git access for the import; S7V-052 provides it from `SystemGit` and `GitVcsDriver`. */
export interface LegacyGitAccess {
  /** Whether a working system git exists, decided without starting any process. */
  readonly available: Effect.Effect<boolean>;
  /** `git show <ref>:<file>` in `cwd`; None when git cannot read it. */
  readonly show: (cwd: string, ref: string, file: string) => Effect.Effect<Option.Option<string>>;
}

export class LegacyEditHistory extends Context.Service<
  LegacyEditHistory,
  {
    /** The old history of `cwd`, or None when there is none, it is damaged or git is not usable. */
    readonly read: (cwd: string) => Effect.Effect<Option.Option<LegacyHistory>>;
  }
>()("t3/edit/LegacyEditHistory") {}

export const make = Effect.fn("LegacyEditHistory.make")(function* (git: LegacyGitAccess) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const read: LegacyEditHistory["Service"]["read"] = Effect.fn("LegacyEditHistory.read")(
    function* (cwd) {
      // The file comes first: a project with no old history never asks about git.
      const text = yield* fileSystem
        .readFileString(path.join(cwd, CACHE_DIR, LEGACY_HISTORY_FILE))
        .pipe(Effect.option);
      if (Option.isNone(text)) return Option.none();
      const state = decodeLegacyState(text.value);
      if (Option.isNone(state) || state.value.entries.length === 0) return Option.none();
      if (!(yield* git.available)) return Option.none();

      // A step whose edit.json cannot be read is skipped; the cursor moves to the nearest
      // earlier step that was kept.
      const steps: LegacyHistoryStep[] = [];
      let cursor = -1;
      for (const [index, entry] of state.value.entries.entries()) {
        const editJson = yield* git.show(cwd, entry.ref, EDIT_FILE);
        if (Option.isNone(editJson)) continue;
        const projectJson = Option.getOrElse(yield* git.show(cwd, entry.ref, PROJECT_FILE), () =>
          projectFileContents(entry.revision),
        );
        steps.push({
          seq: entry.seq,
          revision: entry.revision,
          editJson: editJson.value,
          projectJson,
        });
        if (index <= state.value.cursor) cursor = steps.length - 1;
      }
      if (steps.length === 0) return Option.none();
      return Option.some({
        steps,
        cursor: Math.max(cursor, 0),
        nextSeq: state.value.nextSeq,
        highestRevision: state.value.highestRevision,
        ...(state.value.knownEdit === undefined ? {} : { knownEdit: state.value.knownEdit }),
      });
    },
  );

  return LegacyEditHistory.of({ read });
});

/** No import: an old project starts a fresh history from its current edit. */
export const layerNone = Layer.succeed(
  LegacyEditHistory,
  LegacyEditHistory.of({
    read: Effect.fn("LegacyEditHistory.readNone")(function* (_cwd: string) {
      return yield* Effect.succeed(Option.none<LegacyHistory>());
    }),
  }),
);
