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
  HISTORY_DIR,
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
import { LegacyEditHistory, type LegacyHistory } from "./LegacyEditHistory.ts";

export { EditHistoryError } from "./EditSnapshotStore.ts";

const MAX_TRACKED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 200;
const REFUSED_DIR = "refused";

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

/**
 * How an edit.json on disk stands against the history: the one the service last wrote (`known`),
 * an earlier step's exact text (`earlier`, a T3 turn revert), something else (`outside`), or a
 * project with no history yet (`no-history`).
 */
export type EditStanding = "known" | "earlier" | "outside" | "no-history";

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
    /**
     * Whether edit.json is what the history last recorded or restored. Fails only when the log
     * cannot be read, so an unreadable history never passes for an empty one.
     */
    readonly standing: (
      cwd: string,
      editJson: string,
    ) => Effect.Effect<EditStanding, EditHistoryError>;
    /** The edit.json text the service last wrote, from `.s7history/`; None with no history. */
    readonly lastAccepted: (cwd: string) => Effect.Effect<Option.Option<string>, EditHistoryError>;
    /** Keeps a refused outside edit.json as `.s7history/refused/<epoch-ms>-edit.json`. */
    readonly keepRefused: (cwd: string, editJson: string) => Effect.Effect<void, EditHistoryError>;
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

  /**
   * Puts the old git history in front of what the log already holds (S7V-051 AC-7). With an empty
   * log the old cursor and redo steps come along; otherwise only the old steps up to its cursor, and
   * one equal to the log's first step is dropped. The old file and refs stay as they are.
   */
  const mergeLegacy = Effect.fnUntraced(function* (
    cwd: string,
    log: HistoryLog,
    history: LegacyHistory,
  ) {
    const at = yield* Clock.currentTimeMillis;
    const fresh = log.entries.length === 0;
    const imported: HistoryEntry[] = [];
    for (const step of fresh ? history.steps : history.steps.slice(0, history.cursor + 1)) {
      const files = yield* store.put(cwd, {
        editJson: step.editJson,
        projectJson: step.projectJson,
      });
      imported.push({ seq: step.seq, revision: step.revision, files, at });
    }
    const first = log.entries[0];
    if (first !== undefined && imported.at(-1)?.files[EDIT_FILE] === first.files[EDIT_FILE]) {
      imported.pop();
    }
    const offset = Math.max(history.nextSeq, ...imported.map((entry) => entry.seq + 1)) - 1;
    let entries = [
      ...imported,
      ...log.entries.map((entry) => ({ ...entry, seq: entry.seq + offset })),
    ];
    let cursor = fresh ? history.cursor : imported.length + log.cursor;
    if (entries.length > MAX_HISTORY_ENTRIES) {
      const dropped = entries.length - MAX_HISTORY_ENTRIES;
      entries = entries.slice(dropped);
      cursor = Math.max(cursor - dropped, 0);
    }
    const knownEdit = fresh ? history.knownEdit : log.knownEdit;
    return {
      ...EMPTY_HISTORY_LOG,
      nextSeq: fresh ? offset + 1 : log.nextSeq + offset,
      highestRevision: Math.max(
        log.highestRevision,
        history.highestRevision,
        ...entries.map((entry) => entry.revision),
      ),
      cursor,
      entries,
      ...(knownEdit !== undefined && isSha256Hex(knownEdit) ? { knownEdit } : {}),
      legacy: "imported",
    } satisfies HistoryLog;
  });

  /**
   * The log, with the old git history looked for until a probe-confirmed check has run. A missing
   * or unparseable log is empty, so the next change starts a fresh history from the current edit.
   * Only "none" or "imported" is written; "unchecked" is asked again on the next read.
   */
  const readState = Effect.fnUntraced(function* (cwd: string) {
    const log = yield* store.readLog(cwd);
    if (log.legacy === "imported" || log.legacy === "none") return log;
    const outcome = yield* legacy.read(cwd);
    if (outcome._tag === "unchecked") return log;
    return yield* Effect.gen(function* () {
      const next: HistoryLog =
        outcome._tag === "none"
          ? { ...log, legacy: "none" }
          : yield* mergeLegacy(cwd, log, outcome.history);
      yield* store.writeLog(cwd, next);
      if (outcome._tag === "found") yield* store.collect(cwd, next).pipe(Effect.ignore);
      return next;
    }).pipe(
      // A failed save is tried again on the next read; nothing was recorded yet.
      Effect.orElseSucceed(() => log),
    );
  });

  /** For status, which cannot fail: an unreadable log reads as empty there. */
  const readStateOrEmpty = (cwd: string) =>
    readState(cwd).pipe(Effect.orElseSucceed(() => EMPTY_HISTORY_LOG));

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
      legacy: state.legacy ?? "unchecked",
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

  const standing: EditHistoryService["Service"]["standing"] = Effect.fn(
    "EditHistoryService.standing",
  )(function* (cwd, editJson) {
    const state = yield* readState(cwd);
    if (state.entries.length === 0) return "no-history";
    if (state.knownEdit === undefined) return "known";
    const hash = yield* hashOf(editJson);
    if (state.knownEdit === hash) return "known";
    return state.entries.some((entry) => entry.files[EDIT_FILE] === hash) ? "earlier" : "outside";
  });

  const lastAccepted: EditHistoryService["Service"]["lastAccepted"] = Effect.fn(
    "EditHistoryService.lastAccepted",
  )(function* (cwd) {
    const state = yield* readState(cwd);
    const current = state.entries[state.cursor];
    if (current === undefined) return Option.none<string>();
    const atCursor = store.read(cwd, current.files[EDIT_FILE]);
    // Logs from before S7V-054 may not hold the text a library-keeping undo wrote.
    return Option.some(
      state.knownEdit === undefined
        ? yield* atCursor
        : yield* store.read(cwd, state.knownEdit).pipe(Effect.catch(() => atCursor)),
    );
  });

  const keepRefused: EditHistoryService["Service"]["keepRefused"] = Effect.fn(
    "EditHistoryService.keepRefused",
  )(function* (cwd, editJson) {
    const folder = path.join(cwd, HISTORY_DIR, REFUSED_DIR);
    const at = yield* Clock.currentTimeMillis;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(folder, { recursive: true });
      // `wx` never replaces an earlier refused file from the same millisecond.
      for (let attempt = 0; ; attempt++) {
        const name = attempt === 0 ? `${at}-${EDIT_FILE}` : `${at}-${attempt}-${EDIT_FILE}`;
        const written = yield* fileSystem
          .writeFileString(path.join(folder, name), editJson, { flag: "wx" })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists" && attempt < 100,
              () => Effect.succeed(false),
            ),
          );
        if (written) return;
      }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EditHistoryError({
            cwd,
            reason: "state-write-failed",
            explanation: "Could not keep the refused change to the edit.",
            cause,
          }),
      ),
    );
  });

  const step: EditHistoryService["Service"]["step"] = Effect.fn("EditHistoryService.step")(
    function* (cwd, direction, write) {
      const state = yield* readState(cwd);
      const cursor = state.cursor + (direction === "undo" ? -1 : 1);
      const target = state.entries[cursor];
      if (target === undefined || state.cursor < 0) return Option.none<number>();
      const saved = yield* store.read(cwd, target.files[EDIT_FILE]);
      const revision = state.highestRevision + 1;
      const written = yield* write(saved, revision);
      if (written !== saved) {
        // Library clips were kept: save that text too, so `knownEdit` always names an object.
        const projectJson = yield* fileSystem
          .readFileString(path.join(cwd, PROJECT_FILE))
          .pipe(Effect.orElseSucceed(() => projectFileContents(revision)));
        yield* store.put(cwd, { editJson: written, projectJson });
      }
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
    readStateOrEmpty(cwd).pipe(
      Effect.map((state) => ({
        canUndo: state.cursor > 0,
        canRedo: state.cursor >= 0 && state.cursor < state.entries.length - 1,
        highestRevision: state.highestRevision,
      })),
    );

  return EditHistoryService.of({
    guard,
    ensureBaseline,
    record,
    standing,
    lastAccepted,
    keepRefused,
    step,
    status,
  });
});

export const layer = Layer.effect(EditHistoryService, make);
