// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * The one path that reads and changes a project's `edit.json` (ADR-005). The agent, the timeline
 * and the transcript all call `apply`; every committed change is validated, written atomically,
 * given a new revision in `project.json`, checkpointed for undo and published to subscribers.
 */
import {
  EditConflict,
  type EditDocument,
  type EditMedia,
  type EditOp,
  type EditOrigin,
  type EditSnapshot,
  EditUnavailableError,
  type EditVersion,
  type EditValidationError,
  type EditOpError,
  type ProjectId,
  editValidationError,
  validateEditDocument,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import { allIds, applyEditOps } from "./applyEditOps.ts";
import * as EditHistoryService from "./EditHistoryService.ts";
import * as EditProjectLayout from "./EditProjectLayout.ts";
import { migrateEditDocument } from "./editMigrations.ts";
import type { EditVersionRecord } from "./EditSnapshotStore.ts";
import { describeOps } from "./describeOps.ts";
import { newOutsideMedia, outsideRefused } from "./outsideEdit.ts";

export type EditApplyError =
  | EditUnavailableError
  | EditConflict
  | EditValidationError
  | EditOpError;

export type EditReply = EditHistoryService.EditReply;

/** Who asked for a change: the chat reply it came from, when the agent made it (S7V-069). */
export interface EditCaller {
  readonly reply?: EditReply | undefined;
}

export class EditDocumentService extends Context.Service<
  EditDocumentService,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<EditSnapshot, EditUnavailableError>;
    /**
     * `summary` is the change's line in the version list (S7V-069); without one it is worded from
     * the ops. Changes with the same `reply` fold into one version.
     */
    readonly apply: (
      projectId: ProjectId,
      ops: ReadonlyArray<EditOp>,
      options: EditCaller & {
        readonly origin: EditOrigin;
        readonly baseRevision: number;
        readonly summary?: string | undefined;
      },
    ) => Effect.Effect<EditSnapshot, EditApplyError>;
    /** The current snapshot, then one per change, until the subscriber stops. */
    readonly subscribe: (projectId: ProjectId) => Stream.Stream<EditSnapshot, EditUnavailableError>;
    readonly undo: (
      projectId: ProjectId,
      options?: EditCaller,
    ) => Effect.Effect<EditSnapshot, EditUnavailableError>;
    readonly redo: (
      projectId: ProjectId,
      options?: EditCaller,
    ) => Effect.Effect<EditSnapshot, EditUnavailableError>;
    /**
     * Undo or redo, and whether the step changed the edit, decided inside the project's lock so
     * a write landing just before it cannot make the answer wrong. Clip-list order is ignored:
     * undo and redo put kept clips at the end. For the agent's reply; the RPCs use undo/redo.
     */
    readonly step: (
      projectId: ProjectId,
      direction: "undo" | "redo",
      options?: EditCaller,
    ) => Effect.Effect<
      { readonly snapshot: EditSnapshot; readonly changed: boolean },
      EditUnavailableError
    >;
    /** The project's versions, newest first; the newest is `current` (S7V-069). */
    readonly versions: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<EditVersion>, EditUnavailableError>;
    /** One version and its edit, for a read-only preview: nothing is written. */
    readonly versionDocument: (
      projectId: ProjectId,
      n: number,
    ) => Effect.Effect<
      { readonly version: EditVersion; readonly document: EditDocument },
      EditUnavailableError
    >;
    /** Sets or clears (null) a version's tag; a tag another version has is refused. */
    readonly tagVersion: (
      projectId: ProjectId,
      n: number,
      tag: string | null,
    ) => Effect.Effect<EditVersion, EditUnavailableError>;
    /**
     * Writes version `n`'s edit as a new change (keeping clips in Assets, as undo does), which
     * adds a version "Restored from vN". Nothing is deleted or renumbered.
     */
    readonly restoreVersion: (
      projectId: ProjectId,
      n: number,
      options: EditCaller & { readonly baseRevision: number },
    ) => Effect.Effect<EditSnapshot, EditUnavailableError | EditConflict>;
    /** Removes a version that is not the current one; clips in Assets are never touched. */
    readonly deleteVersion: (
      projectId: ProjectId,
      n: number,
    ) => Effect.Effect<ReadonlyArray<EditVersion>, EditUnavailableError>;
    /**
     * S7V-050: cleans old versions under the project lock and publishes the new snapshot, so
     * `canUndo`, `canRedo` and `cleanup` update. `dryRun` removes nothing and reports the space.
     */
    readonly cleanHistory: (
      projectId: ProjectId,
      mode: EditHistoryService.HistoryCleanMode,
      options?: { readonly dryRun?: boolean },
    ) => Effect.Effect<EditHistoryService.HistoryCleanResult, EditUnavailableError>;
    /** "Not now" for the cleanup question; publishes the snapshot without `cleanup`. */
    readonly dismissCleanup: (
      projectId: ProjectId,
    ) => Effect.Effect<EditSnapshot, EditUnavailableError>;
    /**
     * Marks version `n` (the snapshot's `version` when the export started) as exported once the
     * export has finished, so cleanup keeps it (S7V-050). Never fails; a removed version is skipped.
     */
    readonly markExported: (projectId: ProjectId, n: number) => Effect.Effect<void>;
  }
>()("t3/edit/EditDocumentService") {}

/** What clients see of a version: its record without the object ids. */
const versionOf = (record: EditVersionRecord, current: boolean): EditVersion => {
  const { files: _files, ...rest } = record;
  return { ...rest, current };
};

const newestFirst = (records: ReadonlyArray<EditVersionRecord>) =>
  records.map((record, index) => versionOf(record, index === records.length - 1)).toReversed();

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const startingEdit = EditProjectLayout.STARTING_EDIT;
const startingEditText = EditProjectLayout.editFileContents(startingEdit);
const decodeProjectFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(EditProjectLayout.EditProjectFile),
);

/** Two edits are the same when only the order of their clip lists differs. */
const sameEdit = (left: EditDocument, right: EditDocument) => {
  const byId = (document: EditDocument) => ({
    ...document,
    media: document.media.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  });
  return (
    EditProjectLayout.editFileContents(byId(left)) ===
    EditProjectLayout.editFileContents(byId(right))
  );
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const layout = yield* EditProjectLayout.EditProjectLayout;
  const history = yield* EditHistoryService.EditHistoryService;

  // One writer per project; keyed by the resolved root so two ids for one folder share it.
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (root: string) => {
    let lock = locks.get(root);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(root, lock);
    }
    return lock;
  };
  const channels = new Map<string, PubSub.PubSub<EditSnapshot>>();
  const channelFor = Effect.fnUntraced(function* (root: string) {
    const existing = channels.get(root);
    if (existing !== undefined) return existing;
    const created = yield* PubSub.unbounded<EditSnapshot>();
    const raced = channels.get(root);
    if (raced !== undefined) return raced;
    channels.set(root, created);
    return created;
  });

  const unavailable = (
    projectId: ProjectId,
    reason: EditUnavailableError["reason"],
    explanation: string,
  ) => new EditUnavailableError({ projectId, reason, explanation });

  const resolveRoot = Effect.fnUntraced(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(() =>
          unavailable(projectId, "unreadable", "Could not look up this project."),
        ),
      );
    if (Option.isNone(project)) {
      return yield* unavailable(projectId, "unknown-project", "This project no longer exists.");
    }
    const root = path.resolve(project.value.workspaceRoot);
    if (!(yield* layout.isEditProject(root))) {
      return yield* unavailable(
        projectId,
        "not-an-edit-project",
        "This project has no edit yet. Create a new project to edit video.",
      );
    }
    return root;
  });

  const readFiles = Effect.fnUntraced(function* (projectId: ProjectId, root: string) {
    const unreadable = (explanation: string) => unavailable(projectId, "unreadable", explanation);
    const projectText = yield* fileSystem
      .readFileString(path.join(root, EditProjectLayout.PROJECT_FILE))
      .pipe(Effect.mapError(() => unreadable("Could not read project.json.")));
    const project = decodeProjectFile(projectText);
    if (Option.isNone(project)) return yield* unreadable("project.json is damaged.");
    const editText = yield* fileSystem
      .readFileString(path.join(root, EditProjectLayout.EDIT_FILE))
      .pipe(Effect.mapError(() => unreadable("Could not read edit.json.")));
    return { revision: project.value.revision, editText };
  });

  /** Parses an edit.json text; the failure is the plain reason it cannot be used. */
  const parseEdit = Effect.fnUntraced(function* (projectId: ProjectId, editText: string) {
    const unreadable = (explanation: string) => unavailable(projectId, "unreadable", explanation);
    const parsed = yield* decodeJson(editText).pipe(
      Effect.mapError(() => unreadable("edit.json is not valid JSON.")),
    );
    const migrated = migrateEditDocument(parsed);
    if (migrated._tag === "future") {
      return yield* unavailable(
        projectId,
        "unsupported-version",
        `This edit was saved by a newer version of the app (format ${migrated.version}). Update the app to open it.`,
      );
    }
    if (migrated._tag === "invalid") return yield* unreadable("edit.json has no valid version.");
    const validated = validateEditDocument(migrated.document);
    if (!validated.ok) {
      return yield* unreadable(`edit.json is not valid: ${validated.issues[0]!.explanation}`);
    }
    return validated.document;
  });

  const load = Effect.fnUntraced(function* (projectId: ProjectId, root: string) {
    const files = yield* readFiles(projectId, root);
    return { ...files, document: yield* parseEdit(projectId, files.editText) };
  });

  const snapshotOf = Effect.fnUntraced(function* (
    root: string,
    revision: number,
    document: EditDocument,
  ) {
    const status = yield* history.status(root);
    return {
      revision,
      document,
      canUndo: status.canUndo,
      canRedo: status.canRedo,
      ...(status.version === undefined ? {} : { version: status.version }),
      ...(status.cleanup === undefined ? {} : { cleanup: status.cleanup }),
    };
  });

  /**
   * Temp file in the same folder, fsync, rename, fsync the folder: a crash leaves the old file or
   * the new one. The temp file is removed whenever a step fails.
   */
  const writeAtomic = Effect.fnUntraced(function* (file: string, contents: string) {
    const id = yield* crypto.randomUUIDv4();
    const folder = path.dirname(file);
    const temp = path.join(folder, `.${path.basename(file)}.${id}.tmp`);
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(temp, { flag: "w" });
          yield* handle.writeAll(new TextEncoder().encode(contents));
          yield* handle.sync;
        }),
      );
      yield* fileSystem.rename(temp, file);
    }).pipe(Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)));
    yield* Effect.scoped(
      fileSystem.open(folder, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
    ).pipe(Effect.ignore);
  });

  const historyError = (projectId: ProjectId) => (error: EditHistoryService.EditHistoryError) =>
    unavailable(
      projectId,
      error.reason === "media-in-tracked-folder" ? "media-in-tracked-folder" : "checkpoint-failed",
      error.explanation,
    );

  const publish = Effect.fnUntraced(function* (root: string, snapshot: EditSnapshot) {
    yield* PubSub.publish(yield* channelFor(root), snapshot);
  });

  const locateMedia = (root: string) => (media: EditMedia) =>
    media.path !== undefined ? path.resolve(root, media.path) : path.resolve(media.reference ?? "");

  /**
   * Puts the last accepted edit back over a refused outside one (S7V-054), keeping the refused
   * text under `.s7history/refused/`. Nothing is recorded; subscribers get one snapshot carrying
   * the reason as `notice`, and the caller fails with it.
   */
  const refuseOutside = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    current: { readonly revision: number; readonly editText: string },
    restored: { readonly editText: string; readonly document: EditDocument },
    explanation: string,
  ) {
    yield* history
      .keepRefused(root, current.editText)
      .pipe(Effect.mapError(historyError(projectId)));
    const { highestRevision } = yield* history.status(root);
    const revision = Math.max(current.revision, highestRevision);
    yield* writeEdit(projectId, root, restored.editText, revision, current.editText);
    const snapshot = yield* snapshotOf(root, revision, restored.document);
    yield* publish(root, { ...snapshot, notice: explanation });
    return yield* unavailable(projectId, "outside-change-refused", explanation);
  });

  /**
   * Records an edit.json changed outside this service as a new step, under the project lock, if it
   * is valid and adds no media file; else `refuseOutside`. A read never fails on recording: it
   * returns the file and leaves the problem (the media guard, say) to the next change.
   */
  const loadReconciled = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    mode: "read" | "write",
  ) {
    const files = yield* readFiles(projectId, root);
    const standing = yield* history
      .standing(root, files.editText)
      .pipe(Effect.mapError(historyError(projectId)));
    // No history on a project the service has changed (revision above 0) means the history was
    // lost (a damaged log, an old project): nothing to compare with, so the file is used as it is.
    if (standing === "known" || (standing === "no-history" && files.revision > 0)) {
      return { ...files, document: yield* parseEdit(projectId, files.editText) };
    }
    const parsed = yield* parseEdit(projectId, files.editText).pipe(
      Effect.map((document) => ({ _tag: "valid" as const, document })),
      Effect.catchIf(
        (error) => error.reason !== "unsupported-version",
        () => Effect.succeed({ _tag: "invalid" as const }),
      ),
    );
    if (standing !== "earlier") {
      const accepted = yield* history
        .lastAccepted(root)
        .pipe(Effect.mapError(historyError(projectId)));
      const restored = Option.isSome(accepted)
        ? {
            editText: accepted.value,
            document: yield* parseEdit(projectId, accepted.value),
          }
        : { editText: startingEditText, document: startingEdit };
      const backTo = Option.isSome(accepted) ? "saved" : "start";
      if (parsed._tag === "invalid") {
        const explanation = outsideRefused("invalid", backTo);
        return yield* refuseOutside(projectId, root, files, restored, explanation);
      }
      if (newOutsideMedia(restored.document, parsed.document, locateMedia(root)).length > 0) {
        const explanation = outsideRefused("media", backTo);
        return yield* refuseOutside(projectId, root, files, restored, explanation);
      }
    } else if (parsed._tag === "invalid") {
      // An earlier step's own text cannot be invalid; this only guards the type.
      return yield* unavailable(projectId, "unreadable", "edit.json is not valid.");
    }
    const current = { ...files, document: parsed.document };
    if (standing === "no-history") {
      // A new project (AC-7). A kept outside change becomes the baseline, so a later refusal
      // puts it back instead of the starting edit; a read still never fails on recording.
      if (current.editText !== startingEditText) {
        const baseline = history
          .ensureBaseline(root, current.revision, current.editText)
          .pipe(Effect.mapError(historyError(projectId)));
        yield* mode === "read" ? baseline.pipe(Effect.ignore) : baseline;
      }
      return current;
    }
    const record = Effect.gen(function* () {
      yield* history.guard(root).pipe(Effect.mapError(historyError(projectId)));
      const { highestRevision } = yield* history.status(root);
      const revision = Math.max(current.revision, highestRevision) + 1;
      yield* writeAtomic(
        path.join(root, EditProjectLayout.PROJECT_FILE),
        EditProjectLayout.projectFileContents(revision),
      ).pipe(
        Effect.mapError(() =>
          unavailable(projectId, "write-failed", "Could not save the edit revision."),
        ),
      );
      yield* history
        .record(root, revision, current.editText, {
          author: "outside",
          change:
            standing === "earlier"
              ? "Went back to an earlier edit outside the Editor"
              : "Changed outside the Editor",
        })
        .pipe(Effect.mapError(historyError(projectId)));
      yield* publish(root, yield* snapshotOf(root, revision, current.document));
      return { ...current, revision };
    });
    return mode === "read"
      ? yield* record.pipe(Effect.catch(() => load(projectId, root)))
      : yield* record;
  });

  /**
   * Writes edit.json, then its revision. If the revision cannot be written, edit.json goes back to
   * `previousEdit`, so a failure really leaves nothing changed.
   */
  const writeEdit = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    editText: string,
    revision: number,
    previousEdit: string,
  ) {
    const editFile = path.join(root, EditProjectLayout.EDIT_FILE);
    const writeFailed = () =>
      unavailable(projectId, "write-failed", "Could not save the edit. Nothing changed.");
    yield* writeAtomic(editFile, editText).pipe(Effect.mapError(writeFailed));
    yield* writeAtomic(
      path.join(root, EditProjectLayout.PROJECT_FILE),
      EditProjectLayout.projectFileContents(revision),
    ).pipe(
      Effect.tapError(() => writeAtomic(editFile, previousEdit).pipe(Effect.ignore)),
      Effect.mapError(writeFailed),
    );
  });

  /**
   * Writes a changed edit as one committed change: a new revision, an undo step and a version
   * line (`meta`). Callers hold the project lock and have checked the base revision.
   */
  const commit = Effect.fnUntraced(function* (
    projectId: ProjectId,
    root: string,
    current: { readonly revision: number; readonly editText: string },
    editText: string,
    document: EditDocument,
    meta: EditHistoryService.VersionMeta,
  ) {
    yield* history.guard(root).pipe(Effect.mapError(historyError(projectId)));
    yield* history
      .ensureBaseline(root, current.revision, current.editText)
      .pipe(Effect.mapError(historyError(projectId)));
    const { highestRevision } = yield* history.status(root);
    const revision = Math.max(current.revision, highestRevision) + 1;
    const editFile = path.join(root, EditProjectLayout.EDIT_FILE);
    const projectFile = path.join(root, EditProjectLayout.PROJECT_FILE);
    const previous = yield* Effect.all([
      fileSystem.readFileString(editFile),
      fileSystem.readFileString(projectFile),
    ]).pipe(Effect.orElseSucceed(() => null));
    yield* writeEdit(projectId, root, editText, revision, current.editText);
    yield* history.record(root, revision, editText, meta).pipe(
      Effect.mapError(historyError(projectId)),
      // Keep the edit and its history in step: without a checkpoint the change is undone.
      Effect.tapError(() =>
        previous === null
          ? Effect.void
          : Effect.all([
              writeAtomic(editFile, previous[0]),
              writeAtomic(projectFile, previous[1]),
            ]).pipe(Effect.ignore),
      ),
    );
    const snapshot = yield* snapshotOf(root, revision, document);
    yield* publish(root, snapshot);
    return snapshot;
  });

  const read: EditDocumentService["Service"]["read"] = Effect.fn("EditDocumentService.read")(
    function* (projectId) {
      const root = yield* resolveRoot(projectId);
      return yield* lockFor(root).withPermit(
        Effect.gen(function* () {
          const current = yield* loadReconciled(projectId, root, "read");
          return yield* snapshotOf(root, current.revision, current.document);
        }),
      );
    },
  );

  const apply: EditDocumentService["Service"]["apply"] = Effect.fn("EditDocumentService.apply")(
    function* (projectId, ops, options) {
      yield* Effect.annotateCurrentSpan({ origin: options.origin, ops: ops.length });
      const root = yield* resolveRoot(projectId);
      return yield* lockFor(root).withPermit(
        Effect.gen(function* () {
          const current = yield* loadReconciled(projectId, root, "write");
          if (options.baseRevision !== current.revision) {
            return yield* new EditConflict({
              baseRevision: options.baseRevision,
              currentRevision: current.revision,
            });
          }
          if (ops.length === 0) return yield* snapshotOf(root, current.revision, current.document);
          const applied = applyEditOps(current.document, ops);
          if (applied._tag === "failed") return yield* applied.error;
          const validated = validateEditDocument(applied.document);
          if (!validated.ok) return yield* editValidationError(validated.issues);
          const editText = EditProjectLayout.editFileContents(validated.document);
          // Same bytes: no new revision and no checkpoint, so repeating an edit is free to undo.
          if (editText === current.editText) {
            return yield* snapshotOf(root, current.revision, current.document);
          }
          return yield* commit(projectId, root, current, editText, validated.document, {
            author: options.origin === "agent" ? "assistant" : "you",
            reply: options.reply,
            change: options.summary ?? describeOps(ops, options.origin),
          });
        }),
      );
    },
  );

  /**
   * Undo and redo restore the edit, not the library: a clip in the library now stays there, even
   * when the restored edit is from before its import. Entries the restored edit has keep their
   * recorded form. With nothing to add, the checkpoint's bytes are written as they are. A kept
   * clip whose id the restored edit uses for something else refuses the step (ids share one space).
   */
  const keepLibrary = Effect.fnUntraced(function* (
    projectId: ProjectId,
    action: "undo" | "redo" | { readonly restore: number },
    restoredText: string,
    current: EditDocument,
  ) {
    const doing =
      typeof action === "string" ? `This ${action}` : `Making v${action.restore} current`;
    const again = typeof action === "string" ? `${action} again` : "try again";
    const unreadable = () =>
      unavailable(projectId, "unreadable", "The saved version of this edit could not be read.");
    const parsed = yield* decodeJson(restoredText).pipe(Effect.mapError(unreadable));
    const migrated = migrateEditDocument(parsed);
    if (migrated._tag !== "current") return yield* unreadable();
    const restored = validateEditDocument(migrated.document);
    if (!restored.ok) return yield* unreadable();
    const ids = new Set(restored.document.media.map((media) => media.id));
    const kept = current.media.filter((media) => !ids.has(media.id));
    if (kept.length === 0) return restoredText;
    const taken = allIds(restored.document);
    const clash = kept.find((media) => taken.has(media.id));
    if (clash !== undefined) {
      return yield* unavailable(
        projectId,
        "library-conflict",
        `${doing} would clash with the clip "${clash.id}". Remove that clip from Assets first, then ${again}.`,
      );
    }
    const merged = validateEditDocument({
      ...restored.document,
      media: [...restored.document.media, ...kept],
    });
    if (!merged.ok) {
      return yield* unavailable(
        projectId,
        "library-conflict",
        `${doing} does not fit the clips in Assets: ${merged.issues[0]!.explanation}`,
      );
    }
    return EditProjectLayout.editFileContents(merged.document);
  });

  const step = Effect.fn("EditDocumentService.step")(function* (
    projectId: ProjectId,
    direction: "undo" | "redo",
    options?: EditCaller,
  ) {
    const root = yield* resolveRoot(projectId);
    return yield* lockFor(root).withPermit(
      Effect.gen(function* () {
        const before = yield* loadReconciled(projectId, root, "write");
        // A step that changes nothing visible (only clip order) makes no version (S7V-069).
        let visible = true;
        const reply = options?.reply;
        const moved = yield* history
          .step(
            root,
            direction,
            (editJson, revision) =>
              keepLibrary(projectId, direction, editJson, before.document).pipe(
                Effect.tap((text) => writeEdit(projectId, root, text, revision, before.editText)),
                Effect.tap((text) =>
                  parseEdit(projectId, text).pipe(
                    Effect.map((document) => {
                      visible = !sameEdit(before.document, document);
                    }),
                    Effect.ignore,
                  ),
                ),
              ),
            () =>
              visible
                ? {
                    author: reply === undefined ? "you" : "assistant",
                    reply,
                    change: direction === "undo" ? "Undid the last change" : "Redid a change",
                  }
                : undefined,
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "EditHistoryError" ? historyError(projectId)(error) : error,
            ),
          );
        if (Option.isNone(moved)) {
          return yield* unavailable(
            projectId,
            direction === "undo" ? "nothing-to-undo" : "nothing-to-redo",
            direction === "undo" ? "There is nothing to undo." : "There is nothing to redo.",
          );
        }
        const current = yield* load(projectId, root);
        const snapshot = yield* snapshotOf(root, current.revision, current.document);
        yield* publish(root, snapshot);
        return { snapshot, changed: !sameEdit(before.document, current.document) };
      }),
    );
  });

  const unknownVersion = (projectId: ProjectId, n: number) =>
    unavailable(projectId, "unknown-version", `There is no version v${n} in this project.`);

  /** A version read under the project's lock, so it never sees a half-written log. */
  const withRoot = <A, E>(
    projectId: ProjectId,
    body: (root: string) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | EditUnavailableError> =>
    resolveRoot(projectId).pipe(Effect.flatMap((root) => lockFor(root).withPermit(body(root))));

  const versions: EditDocumentService["Service"]["versions"] = Effect.fn(
    "EditDocumentService.versions",
  )(function* (projectId) {
    return yield* withRoot(projectId, (root) =>
      history
        .versions(root)
        .pipe(Effect.map(newestFirst), Effect.mapError(historyError(projectId))),
    );
  });

  const versionDocument: EditDocumentService["Service"]["versionDocument"] = Effect.fn(
    "EditDocumentService.versionDocument",
  )(function* (projectId, n) {
    return yield* withRoot(projectId, (root) =>
      Effect.gen(function* () {
        const found = yield* history
          .versionText(root, n)
          .pipe(Effect.mapError(historyError(projectId)));
        if (Option.isNone(found)) return yield* unknownVersion(projectId, n);
        const all = yield* history.versions(root).pipe(Effect.mapError(historyError(projectId)));
        return {
          version: versionOf(found.value.version, all.at(-1)?.n === n),
          document: yield* parseEdit(projectId, found.value.editJson),
        };
      }),
    );
  });

  const tagVersion: EditDocumentService["Service"]["tagVersion"] = Effect.fn(
    "EditDocumentService.tagVersion",
  )(function* (projectId, n, tag) {
    return yield* withRoot(projectId, (root) =>
      Effect.gen(function* () {
        const outcome = yield* history
          .tagVersion(root, n, tag)
          .pipe(Effect.mapError(historyError(projectId)));
        if (outcome._tag === "unknown-version") return yield* unknownVersion(projectId, n);
        if (outcome._tag === "tag-taken") {
          return yield* unavailable(
            projectId,
            "tag-taken",
            `v${outcome.by} already has that name. Pick another name.`,
          );
        }
        const all = yield* history.versions(root).pipe(Effect.mapError(historyError(projectId)));
        return versionOf(outcome.version, all.at(-1)?.n === n);
      }),
    );
  });

  const restoreVersion: EditDocumentService["Service"]["restoreVersion"] = Effect.fn(
    "EditDocumentService.restoreVersion",
  )(function* (projectId, n, options) {
    return yield* withRoot(projectId, (root) =>
      Effect.gen(function* () {
        const current = yield* loadReconciled(projectId, root, "write");
        if (options.baseRevision !== current.revision) {
          return yield* new EditConflict({
            baseRevision: options.baseRevision,
            currentRevision: current.revision,
          });
        }
        const found = yield* history
          .versionText(root, n)
          .pipe(Effect.mapError(historyError(projectId)));
        if (Option.isNone(found)) return yield* unknownVersion(projectId, n);
        const editText = yield* keepLibrary(
          projectId,
          { restore: n },
          found.value.editJson,
          current.document,
        );
        // Already the edit: nothing to write, and no version.
        if (editText === current.editText) {
          return yield* snapshotOf(root, current.revision, current.document);
        }
        const document = yield* parseEdit(projectId, editText);
        return yield* commit(projectId, root, current, editText, document, {
          author: options.reply === undefined ? "you" : "assistant",
          reply: options.reply,
          change: `Restored from v${n}`,
          restoredFrom: n,
        });
      }),
    );
  });

  const deleteVersion: EditDocumentService["Service"]["deleteVersion"] = Effect.fn(
    "EditDocumentService.deleteVersion",
  )(function* (projectId, n) {
    return yield* withRoot(projectId, (root) =>
      Effect.gen(function* () {
        const outcome = yield* history
          .deleteVersion(root, n)
          .pipe(Effect.mapError(historyError(projectId)));
        if (outcome === "unknown-version") return yield* unknownVersion(projectId, n);
        if (outcome === "current-version") {
          return yield* unavailable(
            projectId,
            "current-version",
            `v${n} is the current version, so it can't be deleted.`,
          );
        }
        const all = yield* history.versions(root).pipe(Effect.mapError(historyError(projectId)));
        return newestFirst(all);
      }),
    );
  });

  const subscribe: EditDocumentService["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const root = yield* resolveRoot(projectId);
        // Subscribe before reading so no change between the two is lost.
        const subscription = yield* PubSub.subscribe(yield* channelFor(root));
        // A refused outside change already published its snapshot, with the notice, to this
        // subscription; the read's failure is that same news.
        const initial = yield* read(projectId).pipe(
          Effect.map(Stream.make),
          Effect.catchIf(
            (error) => error.reason === "outside-change-refused",
            () => Effect.succeed(Stream.empty),
          ),
        );
        return Stream.concat(initial, Stream.fromSubscription(subscription));
      }),
    );

  const cleanHistory: EditDocumentService["Service"]["cleanHistory"] = Effect.fn(
    "EditDocumentService.cleanHistory",
  )(function* (projectId, mode, options) {
    yield* Effect.annotateCurrentSpan({ mode, dryRun: options?.dryRun === true });
    const root = yield* resolveRoot(projectId);
    return yield* lockFor(root).withPermit(
      Effect.gen(function* () {
        // An outside change is recorded (or refused) first, so the step kept is the edit on disk.
        const current = yield* loadReconciled(projectId, root, "write");
        const result = yield* history
          .clean(root, mode, options)
          .pipe(Effect.mapError(historyError(projectId)));
        if (options?.dryRun !== true) {
          yield* publish(root, yield* snapshotOf(root, current.revision, current.document));
        }
        return result;
      }),
    );
  });

  const dismissCleanup: EditDocumentService["Service"]["dismissCleanup"] = Effect.fn(
    "EditDocumentService.dismissCleanup",
  )(function* (projectId) {
    const root = yield* resolveRoot(projectId);
    return yield* lockFor(root).withPermit(
      Effect.gen(function* () {
        const current = yield* loadReconciled(projectId, root, "write");
        yield* history.dismissCleanup(root).pipe(Effect.mapError(historyError(projectId)));
        const snapshot = yield* snapshotOf(root, current.revision, current.document);
        yield* publish(root, snapshot);
        return snapshot;
      }),
    );
  });

  const markExported: EditDocumentService["Service"]["markExported"] = Effect.fn(
    "EditDocumentService.markExported",
  )(
    function* (projectId, n) {
      const root = yield* resolveRoot(projectId);
      yield* lockFor(root).withPermit(history.markExported(root, n));
    },
    (effect) => Effect.ignore(effect),
  );

  return EditDocumentService.of({
    read,
    cleanHistory,
    dismissCleanup,
    markExported,
    apply,
    subscribe,
    undo: Effect.fn("EditDocumentService.undo")(function* (projectId, options) {
      return (yield* step(projectId, "undo", options)).snapshot;
    }),
    redo: Effect.fn("EditDocumentService.redo")(function* (projectId, options) {
      return (yield* step(projectId, "redo", options)).snapshot;
    }),
    step,
    versions,
    versionDocument,
    tagVersion,
    restoreVersion,
    deleteVersion,
  });
});

export const layer = Layer.effect(EditDocumentService, make);
