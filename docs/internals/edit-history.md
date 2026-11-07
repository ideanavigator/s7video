<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Edit history

Undo and redo for `edit.json` keep their history in the project's `.s7history/` folder, with no git
(ADR-005 Amendment 1, S7V-051). The code is in `apps/server/src/edit/`:
`EditSnapshotStore.ts` (files on disk), `EditHistoryService.ts` (steps, cap, media guard) and
`LegacyEditHistory.ts` (one-time import of the old git history).

## Layout and write order

```
.s7history/
  objects/<sha256>.json.gz   gzip of one edit.json or project.json text; the name is the sha256 of
                             the uncompressed text, so equal texts share one object
  log.json                   format "s7history", version 1: entries, cursor, knownEdit
```

- One history step is one log entry naming two objects (`files["edit.json"]`, `files["project.json"]`).
- `record` writes the objects first, then the log. Each file goes to a temp file, is fsynced and
  renamed; the folder is fsynced once per batch. A crash before the log rename leaves the previous
  log and some objects that no log names. Nothing reads those orphans, and `collect` removes them.
- A missing, damaged or inconsistent log (cursor outside the entries) reads as an empty history. The
  next change records a fresh baseline from the current edit.
- `step` reads only the `edit.json` object, which is checked against its sha256 before use. The text
  saved after `keepLibrary` is hashed as `knownEdit`; that is the saved text, not the object.

## Rules for code that builds on the store

- **Use `EditDocumentService`.** Every store call runs under its per-project lock (`lockFor`).
  Cleanup (S7V-050), versions (S7V-069, S7V-070) and the outside-edit guard (S7V-054) add a method
  on `EditDocumentService`; they do not call `EditSnapshotStore` directly.
- **Only `collect` deletes objects**, and only inside `.s7history/objects/`. It keeps every object
  that `liveObjects(log)` names. A card that adds references to the log (for example S7V-069's
  `versions[*].files`) adds them to `liveObjects` in the same file. Otherwise `collect` deletes them.
- **Log format changes:** a new optional key keeps `version: 1`. A new required key needs
  `version: 2` and a migration test.
- `collect` runs after a step drops redo entries or goes past the 200-entry cap. It is not run on
  every change, to keep capture fast. Crash orphans wait for the next such run or for cleanup.

## API (`EditSnapshotStore`)

| Method                                | Does                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `put(cwd, { editJson, projectJson })` | Saves both texts as objects (skips existing ones); returns `HistoryFiles`.                               |
| `read(cwd, objectId)`                 | The saved text; fails with `checkpoint-failed` if missing or damaged.                                    |
| `readLog(cwd)` / `hasLog(cwd)`        | The log (empty when missing or damaged) / whether `log.json` exists at all.                              |
| `writeLog(cwd, log)`                  | Atomic replace of `log.json`.                                                                            |
| `collect(cwd, log)`                   | Deletes unnamed objects and leftover temp files in `objects/`; returns `{ removedObjects, freedBytes }`. |
| `usage(cwd)`                          | `{ objects, bytes }` of the objects on disk.                                                             |

## Media guard

`EditHistoryService.guard` refuses a change while a video or sound file, or any file over 10 MB,
is in `TRACKED_PATHS` (`EditProjectLayout.ts`). These are the files and folders the whitelist
`.gitignore` keeps, so T3's turn checkpoints never pick them up where git exists. The guard uses the
file system only. `EditProjectLayout.test.ts` checks that `TRACKED_PATHS` covers what git tracks.
If the whitelist changes, change both.

## Projects from before S7V-051

Old projects kept edit history in `.s7cache/edit-history.json` and in refs
`refs/t3/edit/checkpoints/<seq>`. When `log.json` is missing, `EditHistoryService` asks
`LegacyEditHistory.read` once. If an old history comes back, its steps are saved as objects and a
log, and undo reaches the old steps. The old file and refs are never changed. The server uses
`LegacyEditHistory.layerNone` until S7V-052 lands. That card provides `LegacyEditHistory.make` with
its no-spawn `SystemGit` probe as `available` and a `git show <ref>:<file>` as `show`, because
starting Apple's `/usr/bin/git` stub opens the "install developer tools" dialog. Without a working
git, an old project starts a fresh history.
