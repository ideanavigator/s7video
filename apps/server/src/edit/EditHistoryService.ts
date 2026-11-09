// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Undo and redo for `edit.json` on s7video's own snapshot store (ADR-005 Amendment 1, S7V-051): no
 * git. Each committed change is one log entry naming saved copies of `edit.json` and `project.json`.
 * A step reads only `edit.json` back; nothing else in the project is restored, cleaned or deleted.
 */
import {
  EDIT_VERSION_TAG_MAX,
  type EditVersionAuthor,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
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
  type EditVersionRecord,
  EMPTY_HISTORY_LOG,
  type HistoryEntry,
  type HistoryFiles,
  type HistoryLog,
  Sha256Hex,
} from "./EditSnapshotStore.ts";
import { LegacyEditHistory, type LegacyHistory } from "./LegacyEditHistory.ts";

export { EditHistoryError } from "./EditSnapshotStore.ts";

const MAX_TRACKED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 200;

/**
 * S7V-050: the cleanup question appears past either size (PO 2026-11-07). "Versions" are S7V-069's
 * numbered versions; undo steps are "steps".
 */
export const CLEANUP_ASK_VERSIONS = 50;
export const CLEANUP_ASK_BYTES = 200 * 1024 * 1024;
/** After "Not now", asked again once this many more versions were saved, or the size doubles. */
export const CLEANUP_ASK_AGAIN_VERSIONS = 50;
/** "Keep recent" keeps this many of the newest versions, plus those the keep rules name. */
export const CLEANUP_KEEP_RECENT = 20;
/** "Keep recent" also keeps this many of the newest undo steps (and the current step). */
const CLEANUP_KEEP_STEPS = 20;

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

/** The history's size: its numbered versions (S7V-069) and the bytes of its saved objects. */
export interface HistoryUsage {
  readonly versions: number;
  readonly bytes: number;
}

export interface EditHistoryStatus {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly highestRevision: number;
  /** The newest version's number (S7V-069), when there is one. */
  readonly version: number | undefined;
  /** Present when the cleanup question is due (S7V-050). */
  readonly cleanup?: HistoryUsage;
}

/** The chat reply a change came from: every change with the same pair folds into one version. */
export interface EditReply {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

/** What a committed change records in the version list (S7V-069). */
export interface VersionMeta {
  readonly author: EditVersionAuthor;
  readonly reply?: EditReply | undefined;
  /** One plain line: "Removed 14.2 s of silence in 26 cuts". */
  readonly change: string;
  readonly restoredFrom?: number | undefined;
}

const MAX_VERSION_CHANGES = 10;
const MAX_CHANGE_CHARS = 200;
const MORE_CHANGES = "…and more changes";

const clipChange = (text: string) => {
  const line = text.trim().replace(/\s+/gu, " ") || "Changed the edit";
  return line.length > MAX_CHANGE_CHARS ? `${line.slice(0, MAX_CHANGE_CHARS - 1)}…` : line;
};

/** The version keys of a log, for code that rebuilds a log from `EMPTY_HISTORY_LOG`. */
const versionKeys = (log: HistoryLog) => ({
  ...(log.nextVersion === undefined ? {} : { nextVersion: log.nextVersion }),
  ...(log.versions === undefined ? {} : { versions: log.versions }),
});

/** The next unused number: `nextVersion` never goes down, and is never below a listed one. */
const nextVersionOf = (log: HistoryLog) =>
  Math.max(log.nextVersion ?? 1, ...(log.versions ?? []).map((version) => version.n + 1));

/**
 * The version keys after one committed change: folded into the newest version when the same
 * reply made it (one reply, one version), else a new version with the next number.
 */
const withVersion = (
  log: HistoryLog,
  files: HistoryFiles,
  revision: number,
  at: number,
  meta: VersionMeta,
): Pick<HistoryLog, "nextVersion" | "versions"> => {
  const versions = log.versions ?? [];
  const newest = versions.at(-1);
  const change = clipChange(meta.change);
  const sameReply =
    newest !== undefined &&
    meta.reply !== undefined &&
    newest.author === meta.author &&
    newest.threadId === meta.reply.threadId &&
    newest.runId === meta.reply.runId;
  if (sameReply) {
    const changes =
      newest.changes.length < MAX_VERSION_CHANGES - 1
        ? [...newest.changes, change]
        : [...newest.changes.slice(0, MAX_VERSION_CHANGES - 1), MORE_CHANGES];
    const folded: EditVersionRecord = {
      ...newest,
      files,
      revision,
      at,
      changes,
      ...(newest.restoredFrom === undefined && meta.restoredFrom !== undefined
        ? { restoredFrom: meta.restoredFrom }
        : {}),
    };
    return { nextVersion: nextVersionOf(log), versions: [...versions.slice(0, -1), folded] };
  }
  const n = nextVersionOf(log);
  const added: EditVersionRecord = {
    n,
    files,
    revision,
    at,
    author: meta.author,
    ...(meta.reply === undefined ? {} : { threadId: meta.reply.threadId, runId: meta.reply.runId }),
    changes: [change],
    ...(meta.restoredFrom === undefined ? {} : { restoredFrom: meta.restoredFrom }),
  };
  return { nextVersion: n + 1, versions: [...versions, added] };
};

/** Tags compare without case or surrounding space, so "Tight cut" and "tight cut" clash. */
const tagKey = (tag: string) => tag.trim().toLowerCase();

export type TagVersionOutcome =
  | { readonly _tag: "tagged"; readonly version: EditVersionRecord }
  | { readonly _tag: "unknown-version" }
  | { readonly _tag: "tag-taken"; readonly by: number };

export type DeleteVersionOutcome = "deleted" | "unknown-version" | "current-version";

export type HistoryCleanMode = "keep-recent" | "remove-all";

export interface HistoryCleanResult {
  /** Numbered versions (S7V-069) removed. */
  readonly removedVersions: number;
  /** Undo steps removed. */
  readonly removedSteps: number;
  readonly freedBytes: number;
}

/**
 * Whether to ask: past either size, and, after "Not now", 50 more versions saved since (counted
 * from `nextVersion`, so deleted versions and caps never hide growth) or twice the bytes.
 */
export const cleanupDue = (usage: HistoryUsage, log: HistoryLog) => {
  if (usage.versions <= CLEANUP_ASK_VERSIONS && usage.bytes <= CLEANUP_ASK_BYTES) return false;
  const dismissed = log.cleanup?.dismissedAt;
  if (dismissed === undefined) return true;
  return (
    nextVersionOf(log) >= dismissed.nextVersion + CLEANUP_ASK_AGAIN_VERSIONS ||
    usage.bytes >= dismissed.bytes * 2
  );
};

type KeepRule = (
  version: EditVersionRecord,
  index: number,
  versions: ReadonlyArray<EditVersionRecord>,
) => boolean;

const keepsCurrent: KeepRule = (_version, index, versions) => index === versions.length - 1;
const keepsTagged: KeepRule = (version) => version.tag !== undefined;
const keepsExported: KeepRule = (version) => version.exported === true;

/** Which versions each cleanup keeps; a version any rule names stays. */
const CLEANUP_KEEP_RULES: Readonly<Record<HistoryCleanMode, ReadonlyArray<KeepRule>>> = {
  "keep-recent": [
    (_version, index, versions) => index >= versions.length - CLEANUP_KEEP_RECENT,
    keepsCurrent,
    keepsTagged,
    keepsExported,
  ],
  "remove-all": [keepsCurrent, keepsTagged, keepsExported],
};

/** The versions a cleanup keeps, oldest first. */
export const keepForCleanup = (
  versions: ReadonlyArray<EditVersionRecord>,
  mode: HistoryCleanMode,
): ReadonlyArray<EditVersionRecord> =>
  versions.filter((version, index) =>
    CLEANUP_KEEP_RULES[mode].some((keeps) => keeps(version, index, versions)),
  );

/** The undo steps a cleanup keeps: the newest `CLEANUP_KEEP_STEPS` and the current one, or only it. */
const stepsToKeep = (log: HistoryLog, mode: HistoryCleanMode) =>
  log.entries.filter(
    (_entry, index) =>
      index === log.cursor ||
      (mode === "keep-recent" && index >= log.entries.length - CLEANUP_KEEP_STEPS),
  );

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
    /**
     * Captures the files after a committed change and drops any redo steps. With `meta`, the
     * change also goes into the version list (S7V-069): folded into the newest version when the
     * same reply made it, else as a new version.
     */
    readonly record: (
      cwd: string,
      revision: number,
      editJson: string,
      meta?: VersionMeta,
    ) => Effect.Effect<void, EditHistoryError>;
    /**
     * Whether edit.json is what the history last recorded or restored. A missing or unparseable
     * log reads as `no-history`; a log that exists but cannot be read (permissions, I/O) fails, so
     * every read fails until it can be read again rather than skip the check.
     */
    readonly standing: (
      cwd: string,
      editJson: string,
    ) => Effect.Effect<EditStanding, EditHistoryError>;
    /** The edit.json text the service last wrote, from `.s7history/`; None with no history. */
    readonly lastAccepted: (cwd: string) => Effect.Effect<Option.Option<string>, EditHistoryError>;
    /** Keeps a refused outside edit.json under `.s7history/refused/` (see `EditSnapshotStore`). */
    readonly keepRefused: (cwd: string, editJson: string) => Effect.Effect<void, EditHistoryError>;
    /**
     * Steps back or forward; only `edit.json` comes from the saved step, and `write` returns the
     * text it saved (it may keep library clips). None when there is nothing to step to. `meta`,
     * asked after `write`, also records a version (S7V-069); undefined records none.
     */
    readonly step: <E>(
      cwd: string,
      direction: "undo" | "redo",
      write: (editJson: string, revision: number) => Effect.Effect<string, E>,
      meta?: () => VersionMeta | undefined,
    ) => Effect.Effect<Option.Option<number>, EditHistoryError | E>;
    readonly status: (cwd: string) => Effect.Effect<EditHistoryStatus>;
    /** The project's versions, oldest first (S7V-069). */
    readonly versions: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<EditVersionRecord>, EditHistoryError>;
    /** One version and its saved edit.json text; None for a number not in the list. */
    readonly versionText: (
      cwd: string,
      n: number,
    ) => Effect.Effect<
      Option.Option<{ readonly version: EditVersionRecord; readonly editJson: string }>,
      EditHistoryError
    >;
    /** Sets (trimmed, 1-40 characters) or clears one version's tag; tags are unique per project. */
    readonly tagVersion: (
      cwd: string,
      n: number,
      tag: string | null,
    ) => Effect.Effect<TagVersionOutcome, EditHistoryError>;
    /**
     * Removes one version from the list (never the current one) and the objects only it named.
     * Numbers are not reused; nothing in Assets is touched.
     */
    readonly deleteVersion: (
      cwd: string,
      n: number,
    ) => Effect.Effect<DeleteVersionOutcome, EditHistoryError>;
    /** Versions and object bytes (S7V-050); the size is measured once per change to the log. */
    readonly usage: (cwd: string) => Effect.Effect<HistoryUsage>;
    /**
     * S7V-050: keeps `keepForCleanup`'s versions and the newest 20 steps (or, for "remove-all",
     * only the current step, plus the safe S7V-024 git cleanup). Log first, then `collect`;
     * `nextVersion` is kept. `dryRun` changes nothing and reports what it would free.
     */
    readonly clean: (
      cwd: string,
      mode: HistoryCleanMode,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<HistoryCleanResult, EditHistoryError>;
    /** "Not now": records the current size, so the question waits until it grows (S7V-050). */
    readonly dismissCleanup: (cwd: string) => Effect.Effect<void, EditHistoryError>;
    /** Marks version `n` as exported, so cleanup keeps it (S7V-050); a missing `n` is ignored. */
    readonly markExported: (cwd: string, n: number) => Effect.Effect<void, EditHistoryError>;
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
      ...versionKeys(log),
      ...(log.cleanup === undefined ? {} : { cleanup: log.cleanup }),
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
    meta?: VersionMeta,
  ) {
    const projectJson = yield* fileSystem
      .readFileString(path.join(cwd, PROJECT_FILE))
      .pipe(Effect.orElseSucceed(() => projectFileContents(revision)));
    const files = yield* store.put(cwd, { editJson, projectJson });
    const at = yield* Clock.currentTimeMillis;
    const entries: HistoryEntry[] = [
      ...state.entries.slice(0, state.cursor + 1),
      { seq: state.nextSeq, revision, files, at },
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
      ...(meta === undefined ? versionKeys(state) : withVersion(state, files, revision, at, meta)),
      ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
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
    function* (cwd, revision, editJson, meta) {
      yield* capture(cwd, yield* readState(cwd), revision, editJson, meta);
    },
  );

  const standing: EditHistoryService["Service"]["standing"] = Effect.fn(
    "EditHistoryService.standing",
  )(function* (cwd, editJson) {
    const state = yield* readState(cwd);
    if (state.entries.length === 0) return "no-history";
    const hash = yield* hashOf(editJson);
    // A log imported from git may have no `knownEdit`: the cursor's step is then the last edit.
    const known = state.knownEdit ?? state.entries[state.cursor]?.files[EDIT_FILE];
    if (known === hash) return "known";
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

  const keepRefused: EditHistoryService["Service"]["keepRefused"] = (cwd, editJson) =>
    store.keepRefused(cwd, editJson);

  const step: EditHistoryService["Service"]["step"] = Effect.fn("EditHistoryService.step")(
    function* (cwd, direction, write, meta) {
      const state = yield* readState(cwd);
      const cursor = state.cursor + (direction === "undo" ? -1 : 1);
      const target = state.entries[cursor];
      if (target === undefined || state.cursor < 0) return Option.none<number>();
      const saved = yield* store.read(cwd, target.files[EDIT_FILE]);
      const revision = state.highestRevision + 1;
      const written = yield* write(saved, revision);
      let files = target.files;
      if (written !== saved) {
        // Library clips were kept: save that text too, so `knownEdit` always names an object.
        const projectJson = yield* fileSystem
          .readFileString(path.join(cwd, PROJECT_FILE))
          .pipe(Effect.orElseSucceed(() => projectFileContents(revision)));
        files = yield* store.put(cwd, { editJson: written, projectJson });
      }
      const version = meta?.();
      yield* store.writeLog(cwd, {
        ...state,
        cursor,
        highestRevision: revision,
        knownEdit: yield* hashOf(written),
        ...(version === undefined
          ? {}
          : withVersion(state, files, revision, yield* Clock.currentTimeMillis, version)),
      });
      return Option.some(revision);
    },
  );

  // The objects' size, measured again only when the log changes (one folder listing per change).
  const measured = new Map<string, { readonly key: string; readonly bytes: number }>();
  const usageOf = Effect.fnUntraced(function* (cwd: string, state: HistoryLog) {
    const versions = state.versions?.length ?? 0;
    const key = [
      state.nextSeq,
      state.entries.length,
      state.knownEdit ?? "",
      nextVersionOf(state),
      versions,
    ].join(":");
    const cached = measured.get(cwd);
    if (cached?.key === key) return { versions, bytes: cached.bytes };
    const { bytes } = yield* store.usage(cwd);
    measured.set(cwd, { key, bytes });
    return { versions, bytes };
  });

  const status: EditHistoryService["Service"]["status"] = Effect.fn("EditHistoryService.status")(
    function* (cwd) {
      const state = yield* readStateOrEmpty(cwd);
      const usage = yield* usageOf(cwd, state);
      return {
        canUndo: state.cursor > 0,
        canRedo: state.cursor >= 0 && state.cursor < state.entries.length - 1,
        highestRevision: state.highestRevision,
        version: state.versions?.at(-1)?.n,
        ...(cleanupDue(usage, state) ? { cleanup: usage } : {}),
      };
    },
  );

  const usage: EditHistoryService["Service"]["usage"] = Effect.fn("EditHistoryService.usage")(
    function* (cwd) {
      return yield* usageOf(cwd, yield* readStateOrEmpty(cwd));
    },
  );

  const clean: EditHistoryService["Service"]["clean"] = Effect.fn("EditHistoryService.clean")(
    function* (cwd, mode, options) {
      const state = yield* readState(cwd);
      const current = state.entries[state.cursor];
      if (current === undefined) return { removedVersions: 0, removedSteps: 0, freedBytes: 0 };
      const entries = stepsToKeep(state, mode);
      const before = state.versions ?? [];
      const kept = keepForCleanup(before, mode);
      const { cleanup: _asked, ...rest } = state;
      const next: HistoryLog = {
        ...rest,
        entries,
        cursor: entries.indexOf(current),
        // Numbers never restart, even when the newest versions go.
        nextVersion: nextVersionOf(state),
        ...(state.versions === undefined ? {} : { versions: kept }),
        // The user chose to drop older versions: an old git history found later stays out.
        legacy: state.legacy === "imported" ? "imported" : "none",
      };
      const removed = {
        removedVersions: before.length - kept.length,
        removedSteps: state.entries.length - entries.length,
      };
      if (options?.dryRun === true) {
        const { freedBytes } = yield* store.collect(cwd, next, { dryRun: true });
        return { ...removed, freedBytes };
      }
      // The log goes first: a crash before it leaves the old history whole; after it, orphans.
      yield* store.writeLog(cwd, next);
      const { freedBytes } = yield* store.collect(cwd, next);
      if (mode === "remove-all") yield* legacy.removeLeftovers(cwd);
      return { ...removed, freedBytes };
    },
  );

  const dismissCleanup: EditHistoryService["Service"]["dismissCleanup"] = Effect.fn(
    "EditHistoryService.dismissCleanup",
  )(function* (cwd) {
    const state = yield* readState(cwd);
    if (state.entries.length === 0) return;
    const { bytes } = yield* usageOf(cwd, state);
    yield* store.writeLog(cwd, {
      ...state,
      cleanup: { dismissedAt: { nextVersion: nextVersionOf(state), bytes } },
    });
  });

  const markExported: EditHistoryService["Service"]["markExported"] = Effect.fn(
    "EditHistoryService.markExported",
  )(function* (cwd, n) {
    const state = yield* readState(cwd);
    const list = state.versions ?? [];
    const version = list.find((candidate) => candidate.n === n);
    if (version === undefined || version.exported === true) return;
    yield* store.writeLog(cwd, {
      ...state,
      versions: list.map((candidate) =>
        candidate === version ? { ...candidate, exported: true } : candidate,
      ),
    });
  });

  const versions: EditHistoryService["Service"]["versions"] = Effect.fn(
    "EditHistoryService.versions",
  )(function* (cwd) {
    return (yield* readState(cwd)).versions ?? [];
  });

  const versionText: EditHistoryService["Service"]["versionText"] = Effect.fn(
    "EditHistoryService.versionText",
  )(function* (cwd, n) {
    const version = ((yield* readState(cwd)).versions ?? []).find((entry) => entry.n === n);
    if (version === undefined) return Option.none();
    return Option.some({ version, editJson: yield* store.read(cwd, version.files[EDIT_FILE]) });
  });

  const tagVersion: EditHistoryService["Service"]["tagVersion"] = Effect.fn(
    "EditHistoryService.tagVersion",
  )(function* (cwd, n, tag) {
    const state = yield* readState(cwd);
    const list = state.versions ?? [];
    const index = list.findIndex((entry) => entry.n === n);
    const found = list[index];
    if (found === undefined) return { _tag: "unknown-version" } as const;
    const trimmed = tag?.trim().replace(/\s+/gu, " ").slice(0, EDIT_VERSION_TAG_MAX) ?? "";
    if (trimmed !== "") {
      const clash = list.find(
        (entry) =>
          entry.n !== n && entry.tag !== undefined && tagKey(entry.tag) === tagKey(trimmed),
      );
      if (clash !== undefined) return { _tag: "tag-taken", by: clash.n } as const;
    }
    const { tag: _old, ...untagged } = found;
    const version: EditVersionRecord = trimmed === "" ? untagged : { ...untagged, tag: trimmed };
    if (version.tag !== found.tag) {
      yield* store.writeLog(cwd, {
        ...state,
        versions: list.map((entry, at) => (at === index ? version : entry)),
      });
    }
    return { _tag: "tagged", version } as const;
  });

  const deleteVersion: EditHistoryService["Service"]["deleteVersion"] = Effect.fn(
    "EditHistoryService.deleteVersion",
  )(function* (cwd, n) {
    const state = yield* readState(cwd);
    const list = state.versions ?? [];
    if (!list.some((entry) => entry.n === n)) return "unknown-version";
    if (list.at(-1)?.n === n) return "current-version";
    const next: HistoryLog = {
      ...state,
      nextVersion: nextVersionOf(state),
      versions: list.filter((entry) => entry.n !== n),
    };
    yield* store.writeLog(cwd, next);
    yield* store.collect(cwd, next).pipe(Effect.ignore);
    return "deleted";
  });

  return EditHistoryService.of({
    guard,
    ensureBaseline,
    record,
    standing,
    lastAccepted,
    keepRefused,
    step,
    status,
    versions,
    versionText,
    tagVersion,
    deleteVersion,
    usage,
    clean,
    dismissCleanup,
    markExported,
  });
});

export const layer = Layer.effect(EditHistoryService, make);
