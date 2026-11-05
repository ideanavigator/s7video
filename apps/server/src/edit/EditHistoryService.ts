// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Undo and redo for `edit.json` on T3's git checkpoints (ADR-005). Each committed change is one
 * checkpoint ref. A step reads only `edit.json` back from its ref; nothing else in the project is
 * restored, cleaned or deleted.
 */
import { CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CACHE_DIR, EDIT_FILE } from "./EditProjectLayout.ts";

/** Hidden refs, outside `refs/t3/orchestration-v2/` so turn cleanup never deletes them. */
const EDIT_CHECKPOINT_REF_PREFIX = "refs/t3/edit/checkpoints";
const HISTORY_FILE = "edit-history.json";
const MAX_TRACKED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 200;

const MEDIA_EXTENSIONS = new Set([
  "3gp",
  "aac",
  "aif",
  "aiff",
  "avi",
  "caf",
  "flac",
  "h264",
  "hevc",
  "m2ts",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "mts",
  "mxf",
  "ogg",
  "opus",
  "wav",
  "webm",
  "wma",
]);

const HistoryEntry = Schema.Struct({ seq: Schema.Int, revision: Schema.Int, ref: Schema.String });

const HistoryState = Schema.Struct({
  version: Schema.Literal(1),
  nextSeq: Schema.Int,
  highestRevision: Schema.Int,
  /** Index into `entries` of the checkpoint matching the current edit. */
  cursor: Schema.Int,
  entries: Schema.Array(HistoryEntry),
  /** sha256 of the edit.json the service last wrote; anything else on disk changed outside it. */
  knownEdit: Schema.optionalKey(Schema.String),
});
type HistoryState = typeof HistoryState.Type;

const EMPTY_HISTORY: HistoryState = {
  version: 1,
  nextSeq: 1,
  highestRevision: 0,
  cursor: -1,
  entries: [],
};
const decodeHistory = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryState));
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(HistoryState));

export class EditHistoryError extends Schema.TaggedError<EditHistoryError>()("EditHistoryError", {
  cwd: Schema.String,
  reason: Schema.Literals(["media-in-tracked-folder", "checkpoint-failed", "state-write-failed"]),
  explanation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.explanation;
  }
}

export interface EditHistoryStatus {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly highestRevision: number;
}

export class EditHistoryService extends Context.Service<
  EditHistoryService,
  {
    /** Refuses when media or a large file would enter git; nothing is captured then. */
    readonly guard: (cwd: string) => Effect.Effect<void, EditHistoryError>;
    /** Captures the current files as the starting point when there is no history yet. */
    readonly ensureBaseline: (
      cwd: string,
      revision: number,
      editJson: string,
    ) => Effect.Effect<void, EditHistoryError>;
    /** Captures the files after a committed change and drops any redo steps. */
    readonly record: (
      cwd: string,
      revision: number,
      editJson: string,
    ) => Effect.Effect<void, EditHistoryError>;
    /** False when edit.json differs from what the history last recorded or restored. */
    readonly isKnown: (cwd: string, editJson: string) => Effect.Effect<boolean>;
    /**
     * Steps back or forward. Only `edit.json` comes from the checkpoint: `write` saves it with the
     * new revision, so no other file (styles, README, notes) is ever restored or deleted.
     * None when there is nothing to undo or redo.
     */
    readonly step: <E>(
      cwd: string,
      direction: "undo" | "redo",
      write: (editJson: string, revision: number) => Effect.Effect<void, E>,
    ) => Effect.Effect<Option.Option<number>, EditHistoryError | E>;
    readonly status: (cwd: string) => Effect.Effect<EditHistoryStatus>;
  }
>()("t3/edit/EditHistoryService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const crypto = yield* Crypto.Crypto;

  const hashOf = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const historyPath = (cwd: string) => path.join(cwd, CACHE_DIR, HISTORY_FILE);

  // A missing or unreadable history (the cache was cleared) starts a fresh one.
  const readState = (cwd: string) =>
    fileSystem.readFileString(historyPath(cwd)).pipe(
      Effect.map((text) => Option.getOrElse(decodeHistory(text), () => EMPTY_HISTORY)),
      Effect.orElseSucceed(() => EMPTY_HISTORY),
    );

  const writeState = Effect.fnUntraced(
    function* (cwd: string, state: HistoryState) {
      const file = historyPath(cwd);
      const temp = `${file}.tmp`;
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
      yield* fileSystem.writeFileString(temp, `${encodeHistory(state)}\n`);
      yield* fileSystem.rename(temp, file);
    },
    (effect, cwd) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EditHistoryError({
              cwd,
              reason: "state-write-failed",
              explanation: "Could not save the undo history.",
              cause,
            }),
        ),
      ),
  );

  const checkpointFailed = (cwd: string) => (cause: unknown) =>
    new EditHistoryError({
      cwd,
      reason: "checkpoint-failed",
      explanation: "Could not save this version of the edit for undo.",
      cause,
    });

  const guard: EditHistoryService["Service"]["guard"] = Effect.fn("EditHistoryService.guard")(
    function* (cwd) {
      const listed = yield* git
        .execute({
          operation: "EditHistoryService.guard",
          cwd,
          args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
          timeoutMs: 10_000,
        })
        .pipe(Effect.mapError(checkpointFailed(cwd)));
      const files = [...new Set(listed.stdout.split("\0").filter(Boolean))];
      for (const file of files) {
        const extension = path.extname(file).slice(1).toLowerCase();
        if (MEDIA_EXTENSIONS.has(extension)) {
          return yield* new EditHistoryError({
            cwd,
            reason: "media-in-tracked-folder",
            explanation: `"${file}" is a video or sound file in a folder the edit history saves. Move it into assets/ so undo never copies it.`,
          });
        }
        const info = yield* fileSystem.stat(path.join(cwd, file)).pipe(Effect.option);
        if (Option.isSome(info) && Number(info.value.size) > MAX_TRACKED_FILE_BYTES) {
          const mib = Math.round(Number(info.value.size) / (1024 * 1024));
          return yield* new EditHistoryError({
            cwd,
            reason: "media-in-tracked-folder",
            explanation: `"${file}" is ${mib} MB, too big for the edit history (10 MB at most). Move it into assets/.`,
          });
        }
      }
    },
  );

  const capture = Effect.fnUntraced(function* (
    cwd: string,
    state: HistoryState,
    revision: number,
    editJson: string,
  ) {
    const ref = `${EDIT_CHECKPOINT_REF_PREFIX}/${state.nextSeq}`;
    yield* checkpoints
      .captureCheckpoint({ cwd, checkpointRef: CheckpointRef.make(ref) })
      .pipe(Effect.mapError(checkpointFailed(cwd)));
    const entries = [
      ...state.entries.slice(0, state.cursor + 1),
      { seq: state.nextSeq, revision, ref },
    ];
    const dropped =
      entries.length > MAX_HISTORY_ENTRIES
        ? entries.splice(0, entries.length - MAX_HISTORY_ENTRIES)
        : [];
    const stale = [...state.entries.slice(state.cursor + 1), ...dropped];
    const next: HistoryState = {
      version: 1,
      nextSeq: state.nextSeq + 1,
      highestRevision: Math.max(state.highestRevision, revision),
      cursor: entries.length - 1,
      entries,
      knownEdit: yield* hashOf(editJson),
    };
    yield* writeState(cwd, next);
    if (stale.length > 0) {
      yield* checkpoints
        .deleteCheckpointRefs({
          cwd,
          checkpointRefs: stale.map((entry) => CheckpointRef.make(entry.ref)),
        })
        .pipe(Effect.ignore);
    }
  });

  const ensureBaseline: EditHistoryService["Service"]["ensureBaseline"] = Effect.fn(
    "EditHistoryService.ensureBaseline",
  )(function* (cwd, revision, editJson) {
    const state = yield* readState(cwd);
    if (state.entries.length > 0) return;
    yield* capture(cwd, state, revision, editJson);
  });

  const record: EditHistoryService["Service"]["record"] = Effect.fn("EditHistoryService.record")(
    function* (cwd, revision, editJson) {
      yield* capture(cwd, yield* readState(cwd), revision, editJson);
    },
  );

  const isKnown: EditHistoryService["Service"]["isKnown"] = Effect.fn("EditHistoryService.isKnown")(
    function* (cwd, editJson) {
      const state = yield* readState(cwd);
      if (state.knownEdit === undefined) return true;
      return state.knownEdit === (yield* hashOf(editJson));
    },
  );

  const step: EditHistoryService["Service"]["step"] = Effect.fn("EditHistoryService.step")(
    function* (cwd, direction, write) {
      const state = yield* readState(cwd);
      const cursor = state.cursor + (direction === "undo" ? -1 : 1);
      const target = state.entries[cursor];
      if (target === undefined || state.cursor < 0) return Option.none<number>();
      const shown = yield* git
        .execute({
          operation: "EditHistoryService.step",
          cwd,
          args: ["show", `${target.ref}:${EDIT_FILE}`],
          timeoutMs: 10_000,
          maxOutputBytes: 256 * 1024 * 1024,
        })
        .pipe(Effect.mapError(checkpointFailed(cwd)));
      const revision = state.highestRevision + 1;
      yield* write(shown.stdout, revision);
      yield* writeState(cwd, {
        ...state,
        cursor,
        highestRevision: revision,
        knownEdit: yield* hashOf(shown.stdout),
      });
      return Option.some(revision);
    },
  );

  const status: EditHistoryService["Service"]["status"] = (cwd) =>
    readState(cwd).pipe(
      Effect.map((state) => ({
        canUndo: state.cursor > 0,
        canRedo: state.cursor >= 0 && state.cursor < state.entries.length - 1,
        highestRevision: state.highestRevision,
      })),
    );

  return EditHistoryService.of({ guard, ensureBaseline, record, isKnown, step, status });
});

export const layer = Layer.effect(EditHistoryService, make);
