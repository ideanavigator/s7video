// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Undo and redo for `edit.json` on s7video's own snapshot store (ADR-005 Amendment 1, S7V-051): no
 * git. Each committed change is one log entry naming saved copies of `edit.json` and `project.json`.
 * A step reads only `edit.json` back; nothing else in the project is restored, cleaned or deleted.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  EDIT_FILE,
  PROJECT_FILE,
  TRACKED_PATHS,
  projectFileContents,
} from "./EditProjectLayout.ts";
import {
  EditHistoryError,
  EditSnapshotStore,
  EMPTY_HISTORY_LOG,
  type HistoryEntry,
  type HistoryLog,
  Sha256Hex,
} from "./EditSnapshotStore.ts";
import { LegacyEditHistory } from "./LegacyEditHistory.ts";

export { EditHistoryError } from "./EditSnapshotStore.ts";

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

const isSha256Hex = Schema.is(Sha256Hex);

export interface EditHistoryStatus {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly highestRevision: number;
}

export class EditHistoryService extends Context.Service<
  EditHistoryService,
  {
    /** Refuses media or a large file where T3's turn checkpoints would save it; nothing is captured then. */
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
     * Steps back or forward. Only `edit.json` comes from the saved step: `write` saves it with the
     * new revision, so no other file (styles, README, notes) is ever restored or deleted. `write`
     * returns the text it saved, which may keep more than the saved step (clips in the library).
     * None when there is nothing to undo or redo.
     */
    readonly step: <E>(
      cwd: string,
      direction: "undo" | "redo",
      write: (editJson: string, revision: number) => Effect.Effect<string, E>,
    ) => Effect.Effect<Option.Option<number>, EditHistoryError | E>;
    readonly status: (cwd: string) => Effect.Effect<EditHistoryStatus>;
  }
>()("t3/edit/EditHistoryService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const store = yield* EditSnapshotStore;
  const legacy = yield* LegacyEditHistory;

  const hashOf = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  /** Saves an old project's git history as objects and a log, once. The old file and refs stay. */
  const importLegacy = Effect.fnUntraced(function* (cwd: string) {
    const old = yield* legacy.read(cwd);
    if (Option.isNone(old)) return EMPTY_HISTORY_LOG;
    const at = yield* Clock.currentTimeMillis;
    const entries: HistoryEntry[] = [];
    for (const step of old.value.steps) {
      const files = yield* store.put(cwd, {
        editJson: step.editJson,
        projectJson: step.projectJson,
      });
      entries.push({ seq: step.seq, revision: step.revision, files, at });
    }
    const { knownEdit } = old.value;
    const log: HistoryLog = {
      ...EMPTY_HISTORY_LOG,
      nextSeq: Math.max(old.value.nextSeq, ...entries.map((entry) => entry.seq + 1)),
      highestRevision: Math.max(old.value.highestRevision, ...entries.map((e) => e.revision)),
      cursor: old.value.cursor,
      entries,
      ...(knownEdit !== undefined && isSha256Hex(knownEdit) ? { knownEdit } : {}),
    };
    yield* store.writeLog(cwd, log);
    return log;
  });

  // A missing log may be an old project's first open: its git history is imported then. A damaged
  // log reads as an empty one, so the next change starts a fresh history from the current edit.
  const readState = (cwd: string) =>
    store
      .hasLog(cwd)
      .pipe(
        Effect.flatMap((exists) =>
          exists
            ? store.readLog(cwd)
            : importLegacy(cwd).pipe(Effect.orElseSucceed(() => EMPTY_HISTORY_LOG)),
        ),
      );

  const trackedFiles = Effect.fnUntraced(function* (cwd: string) {
    const files: string[] = [];
    for (const tracked of TRACKED_PATHS) {
      if (!tracked.endsWith("/")) {
        files.push(tracked);
        continue;
      }
      const folder = tracked.slice(0, -1);
      const names = yield* fileSystem
        .readDirectory(path.join(cwd, folder), { recursive: true })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) files.push(`${folder}/${name.split(path.sep).join("/")}`);
    }
    return files.toSorted();
  });

  const guard: EditHistoryService["Service"]["guard"] = Effect.fn("EditHistoryService.guard")(
    function* (cwd) {
      for (const file of yield* trackedFiles(cwd)) {
        const info = yield* fileSystem.stat(path.join(cwd, file)).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        const extension = path.extname(file).slice(1).toLowerCase();
        if (MEDIA_EXTENSIONS.has(extension)) {
          return yield* new EditHistoryError({
            cwd,
            reason: "media-in-tracked-folder",
            explanation: `"${file}" is a video or sound file in a folder the edit history saves. Move it into assets/ so undo never copies it.`,
          });
        }
        if (Number(info.value.size) > MAX_TRACKED_FILE_BYTES) {
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

  /** Objects first, then the log that names them; the objects of dropped steps go last. */
  const capture = Effect.fnUntraced(function* (
    cwd: string,
    state: HistoryLog,
    revision: number,
    editJson: string,
  ) {
    const projectJson = yield* fileSystem
      .readFileString(path.join(cwd, PROJECT_FILE))
      .pipe(Effect.orElseSucceed(() => projectFileContents(revision)));
    const files = yield* store.put(cwd, { editJson, projectJson });
    const entries: HistoryEntry[] = [
      ...state.entries.slice(0, state.cursor + 1),
      { seq: state.nextSeq, revision, files, at: yield* Clock.currentTimeMillis },
    ];
    const overCap = entries.length > MAX_HISTORY_ENTRIES;
    if (overCap) entries.splice(0, entries.length - MAX_HISTORY_ENTRIES);
    const next: HistoryLog = {
      ...EMPTY_HISTORY_LOG,
      nextSeq: state.nextSeq + 1,
      highestRevision: Math.max(state.highestRevision, revision),
      cursor: entries.length - 1,
      entries,
      knownEdit: yield* hashOf(editJson),
    };
    yield* store.writeLog(cwd, next);
    const droppedRedo = state.cursor + 1 < state.entries.length;
    if (overCap || droppedRedo) yield* store.collect(cwd, next).pipe(Effect.ignore);
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
      const saved = yield* store.read(cwd, target.files[EDIT_FILE]);
      const revision = state.highestRevision + 1;
      const written = yield* write(saved, revision);
      yield* store.writeLog(cwd, {
        ...state,
        cursor,
        highestRevision: revision,
        knownEdit: yield* hashOf(written),
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
