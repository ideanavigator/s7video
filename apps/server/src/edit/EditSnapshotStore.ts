// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off -- gzip of the saved edit texts; Effect has no compression module.
/**
 * The edit history's own store under `.s7history/` (ADR-005 Amendment 1, S7V-051): gzip objects
 * named by the sha256 of their text, and a log. Objects are written before the log that names them,
 * each file atomically with fsync, so a crash leaves the old log plus orphans for `collect`. Callers
 * hold `EditDocumentService`'s project lock; see docs/internals/edit-history.md.
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
import * as NodeZlib from "node:zlib";

import { EditVersionAuthor, RunId, ThreadId } from "@t3tools/contracts";

import { HISTORY_DIR } from "./EditProjectLayout.ts";

const OBJECTS_DIR = "objects";
const LOG_FILE = "log.json";
const OBJECT_SUFFIX = ".json.gz";
const REFUSED_DIR = "refused";
const REFUSED_SUFFIX = "-edit.json";
/** Refused outside edits kept for the user to look at; older ones are removed (S7V-054). */
export const MAX_REFUSED_EDITS = 20;

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

export const HistoryFiles = Schema.Struct({
  /** Object id of the saved edit.json. */
  "edit.json": Sha256Hex,
  /** Object id of the saved project.json. */
  "project.json": Sha256Hex,
});
export type HistoryFiles = typeof HistoryFiles.Type;

export const HistoryEntry = Schema.Struct({
  seq: Schema.Int,
  revision: Schema.Int,
  files: HistoryFiles,
  /** When the step was saved, epoch milliseconds. */
  at: Schema.Int,
  /** An export of this step finished; "Keep recent" keeps it (S7V-050). */
  exported: Schema.optionalKey(Schema.Boolean),
});
export type HistoryEntry = typeof HistoryEntry.Type;

/**
 * One numbered version (S7V-069): the edit after one assistant reply or Editor action. A second,
 * append-only list beside the undo `entries`, naming its own objects, so the undo cap and dropped
 * redo steps never lose a version. Lengths are checked on write, not on read, so a change in those
 * limits never makes an existing log unreadable.
 */
export const EditVersionRecord = Schema.Struct({
  n: Schema.Int,
  files: HistoryFiles,
  revision: Schema.Int,
  /** Epoch milliseconds of its last change. */
  at: Schema.Int,
  author: EditVersionAuthor,
  threadId: Schema.optionalKey(ThreadId),
  runId: Schema.optionalKey(RunId),
  /** One line per change, in order: at most 10, each at most 200 characters. */
  changes: Schema.Array(Schema.String),
  /** 1-40 characters, unique in the project; a tagged version is never cleaned up (S7V-050). */
  tag: Schema.optionalKey(Schema.String),
  restoredFrom: Schema.optionalKey(Schema.Int),
});
export type EditVersionRecord = typeof EditVersionRecord.Type;

/**
 * `.s7history/log.json`, format version 1. Later cards add optional keys only; a new required key
 * needs `version: 2` and a migration test.
 */
export const HistoryLog = Schema.Struct({
  format: Schema.Literal("s7history"),
  version: Schema.Literal(1),
  nextSeq: Schema.Int,
  highestRevision: Schema.Int,
  /** Index into `entries` of the current edit; -1 when there are none. */
  cursor: Schema.Int,
  entries: Schema.Array(HistoryEntry),
  /** sha256 of the edit.json the service last wrote; anything else on disk changed outside it. */
  knownEdit: Schema.optionalKey(Sha256Hex),
  /**
   * Whether the S7V-024 git history was looked for: "imported" or "none" once a probe-confirmed
   * check ran; "unchecked" (or absent) until then, so it is still imported later.
   */
  legacy: Schema.optionalKey(Schema.Literals(["imported", "none", "unchecked"])),
  /**
   * The next version number (S7V-069). Never goes down, also when versions are deleted or
   * cleaned up, so a number is never reused. Absent means 1.
   */
  nextVersion: Schema.optionalKey(Schema.Int),
  /** Numbered versions, oldest first; the last one is the current edit (S7V-069). */
  versions: Schema.optionalKey(Schema.Array(EditVersionRecord)),
  /**
   * The cleanup question (S7V-050): the history's size when the user last said "Not now", so it is
   * asked again only after it grows enough.
   */
  cleanup: Schema.optionalKey(
    Schema.Struct({
      dismissedAt: Schema.Struct({ versions: Schema.Int, bytes: Schema.Int }),
    }),
  ),
});
export type HistoryLog = typeof HistoryLog.Type;

export const EMPTY_HISTORY_LOG: HistoryLog = {
  format: "s7history",
  version: 1,
  nextSeq: 1,
  highestRevision: 0,
  cursor: -1,
  entries: [],
};

const decodeLog = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryLog));
const encodeLog = Schema.encodeSync(Schema.fromJsonString(HistoryLog));

/** A log whose cursor points outside its entries is as damaged as one that does not parse. */
const isConsistent = (log: HistoryLog) =>
  log.entries.length === 0 ? log.cursor === -1 : log.cursor >= 0 && log.cursor < log.entries.length;

export class EditHistoryError extends Schema.TaggedError<EditHistoryError>()("EditHistoryError", {
  cwd: Schema.String,
  reason: Schema.Literals([
    "media-in-tracked-folder",
    "checkpoint-failed",
    "state-read-failed",
    "state-write-failed",
  ]),
  explanation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.explanation;
  }
}

export class EditSnapshotStore extends Context.Service<
  EditSnapshotStore,
  {
    /** gzip + fsync each file's text under objects/<sha256>.json.gz; skips an object already there. */
    readonly put: (
      cwd: string,
      texts: { readonly editJson: string; readonly projectJson: string },
    ) => Effect.Effect<HistoryFiles, EditHistoryError>;
    /** The saved text of one object. */
    readonly read: (cwd: string, objectId: string) => Effect.Effect<string, EditHistoryError>;
    /**
     * The log. A missing or unparseable log is an empty one; any other read error (permissions,
     * I/O) fails with `state-read-failed`, so the history is never overwritten by mistake.
     */
    readonly readLog: (cwd: string) => Effect.Effect<HistoryLog, EditHistoryError>;
    /** Temp file, fsync, rename, fsync folder. */
    readonly writeLog: (cwd: string, log: HistoryLog) => Effect.Effect<void, EditHistoryError>;
    /**
     * Deletes objects that `log` does not name, temp files in objects/ and stale `.log.json.*.tmp`
     * files; never touches anything else. With `dryRun` it deletes nothing and reports what it
     * would free (S7V-050).
     */
    readonly collect: (
      cwd: string,
      log: HistoryLog,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<
      { readonly removedObjects: number; readonly freedBytes: number },
      EditHistoryError
    >;
    /**
     * Keeps a refused outside edit.json as `refused/<epoch-ms>[-n]-edit.json` (S7V-054): skips a
     * copy equal to the newest one and keeps only the newest `MAX_REFUSED_EDITS`.
     */
    readonly keepRefused: (cwd: string, editJson: string) => Effect.Effect<void, EditHistoryError>;
    /** Objects on disk and their total size, and the refused edits kept beside them. */
    readonly usage: (cwd: string) => Effect.Effect<{
      readonly objects: number;
      readonly bytes: number;
      readonly refusedEdits: number;
      readonly refusedBytes: number;
    }>;
  }
>()("t3/edit/EditSnapshotStore") {}

/** `<epoch-ms>[-n]-edit.json` as [time, n]. */
const refusedOrder = (name: string) => {
  const [at = "0", counter] = name.slice(0, -REFUSED_SUFFIX.length).split("-");
  return [Number(at), counter === undefined ? 0 : Number(counter)] as const;
};

/** Every object `log` names: undo steps and versions (S7V-069). */
const liveObjects = (log: HistoryLog): ReadonlySet<string> => {
  const live = new Set<string>();
  for (const { files } of [...log.entries, ...(log.versions ?? [])]) {
    live.add(files["edit.json"]);
    live.add(files["project.json"]);
  }
  // The edit last written, which an outside change is put back to (S7V-054); after an undo that
  // kept library clips it is not any entry's edit.json.
  if (log.knownEdit !== undefined) live.add(log.knownEdit);
  return live;
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const historyDir = (cwd: string) => path.join(cwd, HISTORY_DIR);
  const objectsDir = (cwd: string) => path.join(cwd, HISTORY_DIR, OBJECTS_DIR);
  const logPath = (cwd: string) => path.join(cwd, HISTORY_DIR, LOG_FILE);
  const objectPath = (cwd: string, id: string) =>
    path.join(objectsDir(cwd), `${id}${OBJECT_SUFFIX}`);

  const hashOf = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode), Effect.orDie);

  const failed =
    (cwd: string, reason: "checkpoint-failed" | "state-write-failed") => (cause: unknown) =>
      new EditHistoryError({
        cwd,
        reason,
        explanation:
          reason === "checkpoint-failed"
            ? "Could not save this version of the edit for undo."
            : "Could not save the undo history.",
        cause,
      });

  const syncFolder = (folder: string) =>
    Effect.scoped(
      fileSystem.open(folder, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
    ).pipe(Effect.ignore);

  /** Temp file next to `file`, fsync, rename. The caller fsyncs the folder (once per batch). */
  const writeSynced = Effect.fnUntraced(function* (file: string, bytes: Uint8Array) {
    const id = yield* crypto.randomUUIDv4();
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${id}.tmp`);
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(temp, { flag: "w" });
          yield* handle.writeAll(bytes);
          yield* handle.sync;
        }),
      );
      yield* fileSystem.rename(temp, file);
    }).pipe(Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)));
  });

  /** Creates `.s7history/objects/`, fsyncing the parents the first time so the folders survive. */
  const ensureFolders = Effect.fnUntraced(function* (cwd: string) {
    if (yield* fileSystem.exists(objectsDir(cwd))) return;
    yield* fileSystem.makeDirectory(objectsDir(cwd), { recursive: true });
    yield* syncFolder(historyDir(cwd));
    yield* syncFolder(cwd);
  });

  const putOne = Effect.fnUntraced(function* (cwd: string, text: string) {
    const bytes = new TextEncoder().encode(text);
    const id = yield* hashOf(bytes);
    const file = objectPath(cwd, id);
    if (yield* fileSystem.exists(file)) return { id, wrote: false };
    yield* writeSynced(file, NodeZlib.gzipSync(bytes));
    return { id, wrote: true };
  });

  const put: EditSnapshotStore["Service"]["put"] = Effect.fn("EditSnapshotStore.put")(
    function* (cwd, texts) {
      yield* ensureFolders(cwd);
      const [edit, project] = yield* Effect.all(
        [putOne(cwd, texts.editJson), putOne(cwd, texts.projectJson)],
        { concurrency: 2 },
      );
      // One folder fsync covers both renames.
      if (edit.wrote || project.wrote) yield* syncFolder(objectsDir(cwd));
      return { "edit.json": edit.id, "project.json": project.id };
    },
    (effect, cwd) => effect.pipe(Effect.mapError(failed(cwd, "checkpoint-failed"))),
  );

  const read: EditSnapshotStore["Service"]["read"] = Effect.fn("EditSnapshotStore.read")(
    function* (cwd, objectId) {
      const packed = yield* fileSystem.readFile(objectPath(cwd, objectId));
      const bytes = yield* Effect.try(() => new Uint8Array(NodeZlib.gunzipSync(packed)));
      // A damaged object must never be written back as the edit.
      if ((yield* hashOf(bytes)) !== objectId) {
        return yield* new EditHistoryError({
          cwd,
          reason: "checkpoint-failed",
          explanation: "A saved version of the edit is damaged.",
        });
      }
      return new TextDecoder().decode(bytes);
    },
    (effect, cwd) => effect.pipe(Effect.mapError(failed(cwd, "checkpoint-failed"))),
  );

  const readLog: EditSnapshotStore["Service"]["readLog"] = (cwd) =>
    fileSystem.readFileString(logPath(cwd)).pipe(
      Effect.map((text) =>
        decodeLog(text).pipe(
          Option.filter(isConsistent),
          Option.getOrElse(() => EMPTY_HISTORY_LOG),
        ),
      ),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(EMPTY_HISTORY_LOG),
      ),
      Effect.mapError(
        (cause) =>
          new EditHistoryError({
            cwd,
            reason: "state-read-failed",
            explanation: "Could not read the undo history.",
            cause,
          }),
      ),
    );

  const writeLog: EditSnapshotStore["Service"]["writeLog"] = Effect.fn(
    "EditSnapshotStore.writeLog",
  )(
    function* (cwd, log) {
      yield* fileSystem.makeDirectory(historyDir(cwd), { recursive: true });
      yield* writeSynced(logPath(cwd), new TextEncoder().encode(`${encodeLog(log)}\n`));
      yield* syncFolder(historyDir(cwd));
    },
    (effect, cwd) => effect.pipe(Effect.mapError(failed(cwd, "state-write-failed"))),
  );

  /** Objects (and temp files a crash left behind) in the objects folder, with their sizes. */
  const listObjects = Effect.fnUntraced(function* (cwd: string) {
    const folder = objectsDir(cwd);
    const names = yield* fileSystem
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const found: Array<{
      readonly name: string;
      readonly id: string | null;
      readonly bytes: number;
    }> = [];
    for (const name of names) {
      const id = name.endsWith(OBJECT_SUFFIX) ? name.slice(0, -OBJECT_SUFFIX.length) : null;
      if (id === null && !name.endsWith(".tmp")) continue;
      const info = yield* fileSystem.stat(path.join(folder, name)).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      found.push({ name, id, bytes: Number(info.value.size) });
    }
    return found;
  });

  const collect: EditSnapshotStore["Service"]["collect"] = Effect.fn("EditSnapshotStore.collect")(
    function* (cwd, log, options) {
      const live = liveObjects(log);
      const dryRun = options?.dryRun === true;
      let removedObjects = 0;
      let freedBytes = 0;
      for (const object of yield* listObjects(cwd)) {
        if (object.id !== null && live.has(object.id)) continue;
        if (!dryRun) yield* fileSystem.remove(path.join(objectsDir(cwd), object.name));
        // Leftover temp files free space but are not objects.
        if (object.id !== null) removedObjects += 1;
        freedBytes += object.bytes;
      }
      if (freedBytes > 0 && !dryRun) yield* syncFolder(objectsDir(cwd));
      // A crash before the log rename leaves its temp file next to log.json.
      const names = yield* fileSystem
        .readDirectory(historyDir(cwd))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        if (!name.startsWith(`.${LOG_FILE}.`) || !name.endsWith(".tmp")) continue;
        const file = path.join(historyDir(cwd), name);
        const info = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        if (!dryRun) yield* fileSystem.remove(file);
        freedBytes += Number(info.value.size);
      }
      return { removedObjects, freedBytes };
    },
    (effect, cwd) => effect.pipe(Effect.mapError(failed(cwd, "state-write-failed"))),
  );

  const refusedDir = (cwd: string) => path.join(historyDir(cwd), REFUSED_DIR);

  /** Refused files, oldest first: by time, then by the same-millisecond counter. */
  const listRefused = Effect.fnUntraced(function* (cwd: string) {
    const names = yield* fileSystem
      .readDirectory(refusedDir(cwd))
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    return names
      .filter((name) => /^\d+(-\d+)?-edit\.json$/u.test(name))
      .toSorted((a, b) => {
        const [atA, counterA] = refusedOrder(a);
        const [atB, counterB] = refusedOrder(b);
        return atA - atB || counterA - counterB;
      });
  });

  const keepRefused: EditSnapshotStore["Service"]["keepRefused"] = Effect.fn(
    "EditSnapshotStore.keepRefused",
  )(function* (cwd, editJson) {
    const folder = refusedDir(cwd);
    yield* Effect.gen(function* () {
      const kept = yield* listRefused(cwd);
      const newest = kept.at(-1);
      if (newest !== undefined) {
        const text = yield* fileSystem
          .readFileString(path.join(folder, newest))
          .pipe(Effect.orElseSucceed(() => null));
        if (text === editJson) return;
      }
      yield* fileSystem.makeDirectory(folder, { recursive: true });
      const at = yield* Clock.currentTimeMillis;
      // After the newest file from this millisecond, so the order stays right after pruning;
      // `wx` never replaces a file written at the same moment.
      const sameMoment = kept.map(refusedOrder).filter(([time]) => time === at);
      const first = sameMoment.length === 0 ? 0 : Math.max(...sameMoment.map(([, n]) => n)) + 1;
      for (let attempt = first; ; attempt++) {
        const name = attempt === 0 ? `${at}${REFUSED_SUFFIX}` : `${at}-${attempt}${REFUSED_SUFFIX}`;
        const written = yield* fileSystem
          .writeFileString(path.join(folder, name), editJson, { flag: "wx" })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists" && attempt < first + 100,
              () => Effect.succeed(false),
            ),
          );
        if (written) break;
      }
      const all = yield* listRefused(cwd);
      for (const name of all.slice(0, Math.max(all.length - MAX_REFUSED_EDITS, 0))) {
        yield* fileSystem.remove(path.join(folder, name), { force: true });
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

  const usage: EditSnapshotStore["Service"]["usage"] = Effect.fn("EditSnapshotStore.usage")(
    function* (cwd) {
      const objects = (yield* listObjects(cwd)).filter((object) => object.id !== null);
      let refusedBytes = 0;
      const refused = yield* listRefused(cwd);
      for (const name of refused) {
        const info = yield* fileSystem.stat(path.join(refusedDir(cwd), name)).pipe(Effect.option);
        if (Option.isSome(info)) refusedBytes += Number(info.value.size);
      }
      return {
        objects: objects.length,
        bytes: objects.reduce((sum, object) => sum + object.bytes, 0),
        refusedEdits: refused.length,
        refusedBytes,
      };
    },
    Effect.orElseSucceed(() => ({ objects: 0, bytes: 0, refusedEdits: 0, refusedBytes: 0 })),
  );

  return EditSnapshotStore.of({ put, read, readLog, writeLog, collect, keepRefused, usage });
});

export const layer = Layer.effect(EditSnapshotStore, make);
