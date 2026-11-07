// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Reads the S7V-024 git edit history once for import into `.s7history/` (S7V-051 AC-7). Only
 * "Remove all old versions" (S7V-050) deletes the old file and refs, and only where git works. Git is only used when S7V-052's no-spawn `SystemGit` probe finds a
 * real one, because Apple's `/usr/bin/git` stub opens the "install developer tools" dialog.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { SystemGit } from "../vcs/SystemGit.ts";
import { CACHE_DIR, EDIT_FILE, PROJECT_FILE, projectFileContents } from "./EditProjectLayout.ts";

const LEGACY_HISTORY_FILE = "edit-history.json";
/** S7V-024's checkpoint refs; T3's own turn refs live elsewhere and are left alone. */
const LEGACY_REFS_PREFIX = "refs/t3/edit/";

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

/**
 * What a look for the old history found. "none" and "found" are final and recorded in the log;
 * "unchecked" means no probe-confirmed git was there to look with, so it is asked again later.
 */
export type LegacyOutcome =
  | { readonly _tag: "unchecked" }
  | { readonly _tag: "none" }
  | { readonly _tag: "found"; readonly history: LegacyHistory };

const UNCHECKED: LegacyOutcome = { _tag: "unchecked" };
const NONE: LegacyOutcome = { _tag: "none" };

/** Git access for the import; `layer` provides it from `SystemGit` and `GitVcsDriver`. */
export interface LegacyGitAccess {
  /** Whether a working system git exists, decided without starting any process. */
  readonly available: Effect.Effect<boolean>;
  /**
   * `git show <ref>:<file>` in `cwd`: None when git ran and cannot read it (the step is skipped);
   * a failure when git could not run at all (timeout, spawn error, git gone), which leaves the
   * history `unchecked` so the next read tries again instead of losing it.
   */
  readonly show: (
    cwd: string,
    ref: string,
    file: string,
  ) => Effect.Effect<Option.Option<string>, LegacyGitRunError>;
  /** Runs `git <args>` in `cwd` (S7V-050's leftover removal); absent where tests do not need it. */
  readonly run?: (
    cwd: string,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, LegacyGitRunError>;
}

/** Git could not be run to read the old history; nothing about the history is decided. */
export class LegacyGitRunError extends Schema.TaggedError<LegacyGitRunError>()(
  "LegacyGitRunError",
  { cause: Schema.Defect() },
) {}

/** Far above any edit.json the S7V-024 guard let into history (10 MB). */
const SHOW_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class LegacyEditHistory extends Context.Service<
  LegacyEditHistory,
  {
    /** Looks for the old history of `cwd`; never fails. */
    readonly read: (cwd: string) => Effect.Effect<LegacyOutcome>;
    /**
     * S7V-050 "Remove all old versions": where a working git exists, deletes the project's
     * `refs/t3/edit/*` refs and `.s7cache/edit-history.json`, then `git gc --prune=now --quiet`.
     * Without git it starts no process and changes nothing. Never fails; whether it removed them.
     */
    readonly removeLeftovers: (cwd: string) => Effect.Effect<boolean>;
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
        .pipe(Effect.result);
      if (text._tag === "Failure") {
        return text.failure.reason._tag === "NotFound" ? NONE : UNCHECKED;
      }
      const state = decodeLegacyState(text.success);
      if (Option.isNone(state) || state.value.entries.length === 0) return NONE;
      if (!(yield* git.available)) return UNCHECKED;

      // A step whose edit.json cannot be read is skipped; the cursor moves to the nearest
      // earlier step that was kept.
      const steps: LegacyHistoryStep[] = [];
      let cursor = -1;
      for (const [index, entry] of state.value.entries.entries()) {
        const editJson = yield* git.show(cwd, entry.ref, EDIT_FILE).pipe(Effect.option);
        if (Option.isNone(editJson)) return UNCHECKED;
        if (Option.isNone(editJson.value)) continue;
        const projectShown = yield* git.show(cwd, entry.ref, PROJECT_FILE).pipe(Effect.option);
        if (Option.isNone(projectShown)) return UNCHECKED;
        const projectJson = Option.getOrElse(projectShown.value, () =>
          projectFileContents(entry.revision),
        );
        steps.push({
          seq: entry.seq,
          revision: entry.revision,
          editJson: editJson.value.value,
          projectJson,
        });
        if (index <= state.value.cursor) cursor = steps.length - 1;
      }
      // Git works but could read no step: recorded as none, so it is not retried on every read.
      if (steps.length === 0) return NONE;
      const history: LegacyHistory = {
        steps,
        cursor: Math.max(cursor, 0),
        nextSeq: state.value.nextSeq,
        highestRevision: state.value.highestRevision,
        ...(state.value.knownEdit === undefined ? {} : { knownEdit: state.value.knownEdit }),
      };
      return { _tag: "found", history } satisfies LegacyOutcome;
    },
  );

  const removeLeftovers: LegacyEditHistory["Service"]["removeLeftovers"] = Effect.fn(
    "LegacyEditHistory.removeLeftovers",
  )(function* (cwd) {
    const run = git.run;
    if (run === undefined || !(yield* git.available)) return false;
    return yield* Effect.gen(function* () {
      const listed = yield* run(cwd, ["for-each-ref", "--format=%(refname)", LEGACY_REFS_PREFIX]);
      const refs =
        listed.exitCode === 0
          ? listed.stdout.split("\n").filter((ref) => ref.startsWith(LEGACY_REFS_PREFIX))
          : [];
      if (refs.length > 0) {
        const deleted = yield* run(
          cwd,
          ["update-ref", "--stdin"],
          refs.map((ref) => `delete ${ref}\n`).join(""),
        );
        // Refs still there: keep the file that names them, so nothing is half removed.
        if (deleted.exitCode !== 0) return false;
      }
      yield* fileSystem.remove(path.join(cwd, CACHE_DIR, LEGACY_HISTORY_FILE), { force: true });
      // Not a git repository (exit 128): no objects to collect.
      if (listed.exitCode === 0) yield* run(cwd, ["gc", "--prune=now", "--quiet"]);
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
  });

  return LegacyEditHistory.of({ read, removeLeftovers });
});

/** The server's import: `SystemGit` decides, `git show <ref>:<file>` reads. */
export const layer = Layer.effect(
  LegacyEditHistory,
  Effect.gen(function* () {
    const systemGit = yield* SystemGit;
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* make({
      available: systemGit.status.pipe(Effect.map((status) => status.available)),
      show: (cwd, ref, file) =>
        git
          .execute({
            operation: "LegacyEditHistory.show",
            cwd,
            args: ["show", `${ref}:${file}`],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
            maxOutputBytes: SHOW_MAX_OUTPUT_BYTES,
          })
          .pipe(
            Effect.mapError((cause) => new LegacyGitRunError({ cause })),
            // Only git answering "cannot read this" skips a step; a cut-off read decides nothing.
            Effect.filterOrFail(
              (result) => result.exitCode !== 0 || !result.stdoutTruncated,
              () => new LegacyGitRunError({ cause: "git show output was cut off" }),
            ),
            Effect.map((result) =>
              result.exitCode === 0 ? Option.some(result.stdout) : Option.none<string>(),
            ),
          ),
      run: (cwd, args, stdin) =>
        git
          .execute({
            operation: "LegacyEditHistory.removeLeftovers",
            cwd,
            args,
            ...(stdin === undefined ? {} : { stdin }),
            allowNonZeroExit: true,
            timeoutMs: 120_000,
          })
          .pipe(
            Effect.map((result) => ({ exitCode: Number(result.exitCode), stdout: result.stdout })),
            Effect.mapError((cause) => new LegacyGitRunError({ cause })),
          ),
    });
  }),
);

/** Never looks: every project reports "unchecked" and is looked at later (tests). */
export const layerNone = Layer.succeed(
  LegacyEditHistory,
  LegacyEditHistory.of({
    read: Effect.fn("LegacyEditHistory.readNone")(function* (_cwd: string) {
      return yield* Effect.succeed(UNCHECKED);
    }),
    removeLeftovers: Effect.fn("LegacyEditHistory.removeLeftoversNone")(function* (_cwd: string) {
      return yield* Effect.succeed(false);
    }),
  }),
);
