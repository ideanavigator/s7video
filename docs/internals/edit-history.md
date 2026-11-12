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
  log.json                   format "s7history", version 1: entries, cursor, knownEdit, legacy
  refused/<epoch-ms>[-n]-edit.json   outside edits that were not kept (S7V-054); the newest 20
```

- One history step is one log entry naming two objects (`files["edit.json"]`, `files["project.json"]`).
- `record` writes the objects first, then the log. Each file goes to a temp file, is fsynced and
  renamed; the folder is fsynced once per batch. A crash before the log rename leaves the previous
  log and some objects that no log names. Nothing reads those orphans, and `collect` removes them.
- A missing, unparseable or inconsistent log (cursor outside the entries) reads as an empty
  history, and the next change records a fresh baseline from the current edit. Any other read error
  (permissions, I/O) fails with `state-read-failed`. The change is then refused, so a log that is
  only unreadable for now is never overwritten. `status` and `isKnown` cannot fail and read such a
  log as empty.
- `step` reads only the `edit.json` object, which is checked against its sha256 before use. The text
  saved after `keepLibrary` is hashed as `knownEdit`; that is the saved text, not the object.

## Rules for code that builds on the store

- **Use `EditDocumentService`.** Every store call runs under its per-project lock (`lockFor`).
  Cleanup (S7V-050), versions (S7V-069, S7V-070) and the outside-edit guard (S7V-054) add a method
  on `EditDocumentService`; they do not call `EditSnapshotStore` directly.
- **Only `collect` deletes**, and only objects and temp files inside `.s7history/` (never
  `log.json`); `keepRefused` prunes old files in `refused/` and nothing else. It keeps every object
  that `liveObjects(log)` names: undo entries, `versions[*].files` and `knownEdit`. A card that adds
  references to the log adds them to `liveObjects` in the same file. Otherwise `collect` deletes them.
- **Log format changes:** a new optional key keeps `version: 1`. A new required key needs
  `version: 2` and a migration test.
- `collect` runs after a step drops redo entries or goes past the 200-entry cap, and after an
  import. It is not run on every change, to keep capture fast. Crash orphans, temp files in
  `objects/` and stale `.log.json.*.tmp` files wait for the next such run or for cleanup.

## API (`EditSnapshotStore`)

| Method                                | Does                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `put(cwd, { editJson, projectJson })` | Saves both texts as objects (skips existing ones); returns `HistoryFiles`.                                                                                                                      |
| `read(cwd, objectId)`                 | The saved text; fails with `checkpoint-failed` if missing or damaged.                                                                                                                           |
| `readLog(cwd)`                        | The log: empty when missing or unparseable; fails with `state-read-failed` on any other read error.                                                                                             |
| `writeLog(cwd, log)`                  | Atomic replace of `log.json`.                                                                                                                                                                   |
| `collect(cwd, log, { dryRun? })`      | Deletes unnamed objects, temp files in `objects/` and stale `.log.json.*.tmp` files; returns `{ removedObjects, freedBytes }`. Temp files count in `freedBytes` only. `dryRun` deletes nothing. |
| `keepRefused(cwd, editJson)`          | Saves a refused outside edit under `refused/` (newest 20, no repeat of the newest).                                                                                                             |
| `usage(cwd)`                          | `{ objects, bytes }` of the objects on disk, plus `refusedEdits`, `refusedBytes`.                                                                                                               |

## Cleanup (S7V-050)

Nothing prunes the history on its own. "Versions" here are S7V-069's numbered versions; undo
entries are "steps". Past 50 versions or 200 MB of objects, `EditSnapshot.cleanup` carries
`{ versions, bytes }`, the Editor panel shows a banner, and the video tools that change the edit add
a one-line `cleanup` hint so the agent asks. There is no agent tool: the user answers in the banner
(PO 2026-11-07).

- **Which versions stay** is `CLEANUP_KEEP_RULES[mode]`. Keep recent keeps the last 20 versions,
  the current (last) one, tagged ones and `exported` ones (set when an export of that version
  finishes). Remove all keeps the current, tagged and exported versions.
- **Which steps stay:** keep recent keeps the newest 20 steps and the current one; remove all
  keeps only the current step, so undo starts again from now.
- `clean` keeps every other log key (`...rest`) and writes `nextVersion` explicitly, so numbers never
  restart. `collect` then drops every object no kept step or version names.
- **Old git leftovers (PO 2026-11-08):** remove all touches git only where a working git exists and
  `git rev-parse --show-toplevel` is the project folder. It deletes only the `refs/t3/edit/*` refs
  that `.s7cache/edit-history.json` names, then that file, and runs plain `git gc --quiet` only if a
  ref was deleted. Plain gc keeps git's grace period for unreachable objects, so a T3 checkpoint
  written at the same moment is safe. Without the file or git, no process starts. T3's own turn refs
  are never touched: deleting them would break turn diffs and reverts.
- Both rewrite the log first, then `collect`, so a crash leaves the old history whole or orphans.
  Both set `legacy` to `"none"` when it was not `"imported"`, so an old git history found later is
  not imported back after the user removed old versions.
- **Not now** stores `nextVersion` and the bytes in `cleanup.dismissedAt`. The question comes back
  once 50 more versions have been saved (counted from `nextVersion`, so deleted versions and the step
  cap never hide growth) or the bytes double. A clean removes the key.
- The size is measured by listing `objects/` once per log change (cached by `nextSeq`, step count,
  `knownEdit`, `nextVersion` and version count), since every snapshot carries it.
- With gzip at about 5.5× on real edits, 200 MB needs many versions of multi-megabyte edits; most
  projects reach the 50-version trigger first.

## Versions (S7V-069)

`log.json` keeps a second list, `versions`, beside the undo `entries`, and a counter `nextVersion`
(both optional keys, so the format stays `version: 1`). Undo and versions answer different
questions: undo steps back one change; a version is what the edit looked like after one assistant
reply or one Editor action, and stays listed when undo steps are capped or a redo branch is dropped.

- **One reply, one version.** A change carrying the same `threadId` + `runId` as the newest version
  (the reply's run, from the thread shell's `activeRunId`, or `latestRunId` while that run waits)
  folds into it: its `files` move to the new edit and its `changes` gain a line (at most 10, each
  at most 200 characters). Anything else appends a version with the next number. A change that
  writes the same bytes makes none; an undo or redo that changes nothing visible makes none either.
  Only the newest version folds, so a reply interrupted by another chat's or the Editor's change
  carries on in a new version: one reply, two versions, and the newest is still the current edit.
- **The newest version is the current edit.** Every committed change records one (author `you` for
  the Editor, `outside` for an outside edit that was kept), so the last entry always names it.
- **Numbers are never reused**, with one exception. `nextVersion` only goes up. Code that rebuilds
  a log from `EMPTY_HISTORY_LOG` (cleanup, imports) must carry `nextVersion` and `versions` over, or
  numbers restart and versions vanish. The exception: a damaged or inconsistent `log.json` reads as
  empty (as undo already does since S7V-051), so the next change starts again at v1. Nothing
  outside the log records the old numbers, so a `v12` named in an old chat can then mean another
  edit.
- **Each version names its own objects**, and `liveObjects` keeps them. Deleting a version removes
  its record and runs `collect`; objects an undo step still names stay.
- **Tags** are 1-40 characters, unique per project ignoring case and spacing. S7V-050's cleanup
  keeps every version with a `tag`, and the current (last) one.
- **Make current** reads the version's `edit.json`, keeps today's library clips (`keepLibrary`, as
  undo does), and commits it as a new change with `restoredFrom`. Undo then steps back over it.
- **Versions in chat (S7V-070).** `video_versions` and `video_version_restore` name a version as a
  chat does: `v12` or `12` is a number first, then a tag compared as tags are, so a tag that reads
  as a number loses to that number and the reply names the other version. Both resolve the name
  inside `EditDocumentService` (`findVersion`, `restoreVersionRef`) under the project lock, so the
  tool never reads a number that a cleanup removes before the restore. A restore from chat is a
  change in that reply, so it folds into the reply's version when the reply already changed the
  edit.

## Outside changes (S7V-054)

An `edit.json` the service did not write is checked when it is next read or changed
(`EditHistoryService.standing`). It is recorded as a new step only if it is valid and every media
`path` or `reference` was already in the last accepted edit (compared after resolving against the
project), or if it is the exact text of an earlier step, as a T3 turn revert writes. Anything else
is refused: the text is kept in `refused/`, the last accepted edit is written back, nothing is
recorded, subscribers get one snapshot with `notice`, and the call fails with
`outside-change-refused`.

- **The last accepted edit is `knownEdit`'s object**, not the cursor entry's: an undo that kept
  library clips writes text no entry names, so `step` saves that text as an object too and
  `liveObjects` keeps `knownEdit`. Logs from before S7V-054 fall back to the cursor entry.
- **A log without `knownEdit`** (a git import) compares against the cursor entry's `edit.json`.
- **No history yet:** a project at revision 0 is checked against the starting edit. A kept outside
  change is saved as the baseline (`ensureBaseline`), so a later refusal puts it back; with none,
  a refusal goes back to the starting edit and says so ("back to how it started"). A project above
  revision 0 with an empty log (damaged or unparseable log, old project not yet imported) is read
  as it is, unchecked: there is nothing to compare with, and putting back the starting edit would
  throw the user's work away. Anything that can write `log.json` or `project.json` can therefore
  get past the check.
- **A `log.json` that exists but cannot be read** (permissions, I/O) fails every read and change
  with the history error until it can be read again. Before S7V-054 a read treated it as empty.
- `refused/` keeps the newest `MAX_REFUSED_EDITS` (20) files, skips a copy equal to the newest
  one (a restore that keeps failing would otherwise write one per read), and counts in `usage`.
  `collect` never touches it.

## Media guard

`EditHistoryService.guard` refuses a change while a video or sound file, or any file over 10 MB,
is in `TRACKED_PATHS` (`EditProjectLayout.ts`). These are the files and folders the whitelist
`.gitignore` keeps, so T3's turn checkpoints never pick them up where git exists. The guard uses the
file system only. `EditProjectLayout.test.ts` checks that `TRACKED_PATHS` covers what git tracks.
If the whitelist changes, change both.

## Projects from before S7V-051

Old projects kept edit history in `.s7cache/edit-history.json` and in refs
`refs/t3/edit/checkpoints/<seq>`. The log's optional `legacy` key records whether that history has
been looked for:

| `legacy`                | Meaning                                             | Asked again?       |
| ----------------------- | --------------------------------------------------- | ------------------ |
| absent or `"unchecked"` | no probe-confirmed git looked yet                   | yes, on every read |
| `"none"`                | no old file, or git works but no step could be read | no                 |
| `"imported"`            | old steps are in the log                            | no                 |

`LegacyEditHistory.read` returns `unchecked`, `none` or `found`. It reads the old file first, so a
project without one never asks about git. `EditHistoryService` writes only the final outcomes.
`found` puts the old steps in front of what the log already holds:

- with an empty log, all old steps come in, with the old cursor;
- otherwise only the old steps up to the old cursor come in. One equal to the log's first step is
  dropped, and the new steps get seq numbers after the old ones;
- the 200-step cap still applies.

The old file and refs are changed only by "Remove all old versions" ([Cleanup](#cleanup-s7v-050)). A failed save of the outcome is retried on the next read.

The server provides `LegacyEditHistory.layer`: S7V-052's no-spawn `SystemGit` probe is
`available`, and `git show <ref>:<file>` through `GitVcsDriver` is `show`. Only a non-zero git exit
counts as an unreadable step. A git that cannot run (a timeout, a spawn error, git removed, output
cut off at 64 MiB) leaves the outcome `unchecked`, so a later read tries again and the old history
is never written off. Git is never asked
before the probe says yes, because starting Apple's `/usr/bin/git` stub opens the "install developer
tools" dialog. Without a working git the outcome stays `unchecked`, so an old project works with a
fresh history until git is found. Builds before S7V-052 used `layerNone`, so their logs say
`"unchecked"` and are imported later too. Tests use `layerNone` when they never look.
