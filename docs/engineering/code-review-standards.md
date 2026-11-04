<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Code review standards

Every card pull request is reviewed against its ticket, [AGENTS.md](../../AGENTS.md) and this page
before it merges. This page is what a reviewer applies; the prompts that start a review are in
[ai-code-review-prompts.md](ai-code-review-prompts.md), and the areas that need the closest look are
in [baseline-risk-map.md](baseline-risk-map.md).

## Who reviews

- The reviewer is never the author. For agent work, the reviewer is a separate session with fresh
  context, given the ticket, the diff and these standards, not the author's reasoning.
- The reviewer reads the whole diff, not a summary of it, and runs the gates itself on the head
  commit. A claim in the PR body ("tests pass") is not evidence until the reviewer has seen it.
- A re-review after fixes covers the new commits and checks that each finding's resolution is real.

## Findings

Each finding is a PR comment (inline where possible) and a row in the review artifact. It starts with
`[blocking]` or `[non-blocking]`, then names the location, the problem, why it matters and the fix.

| Severity | Meaning                                                                                                                                      | Blocks merge                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| critical | Data loss or corruption, a secret or user media leaving the machine, writes to T3 Code's data, a blocked licence, client footage in the repo | Always                                         |
| high     | An AC not met, a broken user flow, a security hole, a migration that cannot be rolled forward, a fake or missing required test               | Always                                         |
| medium   | A real defect with limited impact, lost coverage of kept code, a misleading doc, a brittle design                                            | Fixed, or a follow-up ticket or written waiver |
| low      | Clarity, naming, small inaccuracies, minor duplication                                                                                       | No; fix or answer with a reason                |

- Every finding gets a fixing commit or a written reason in the artifact's "Response to findings".
- Waivers name who accepted them (the PO for anything medium or above) and are dated.
- A finding is not resolved by deleting the test that exposed it.

## Sign-off

- Only the reviewer posts `Review sign-off: <full 40-character head SHA>`, on the PR and at the end of
  the artifact.
- Sign-off applies to that exact commit. Any new commit, including a rebase, needs a new sign-off.
- Merge only with `gh pr merge <n> --squash --match-head-commit <signed-off SHA>` after the gates have
  been run locally on that commit and their output posted on the PR.

## The artifact

Save the review to `code-reviews/S7V-XXX.md` in the planning repo, from its `code-reviews/TEMPLATE.md`:
scope reviewed, findings table, standards applied, follow-ups, responses, sign-off. A re-review is
appended as a new section, never edited into the old one.

## What to check

Work through the ticket first, then this list. Write "N/A" with a reason in the artifact's Standards
Applied section rather than skipping a line.

### Correctness against the ticket

- Every AC is met as written, or open with a reason the PO can see. Ticked ACs are verified, not
  trusted.
- Out-of-scope items stayed out. Scope added along the way is either in the ticket or split.
- The confidence checks were run and their results recorded.

### Edit-document integrity

- `edit.json` (the timeline document) changes go through its schema in `packages/contracts`, with a
  version bump and a forward migration when the shape changes. Old documents still open.
- Edits are applied as checkpoints, so every agent change can be diffed and undone. No code path
  writes the edit document outside that flow.
- Original media is never modified. Generated files (proxies, renders) can always be rebuilt.

### Media correctness

Apply [media-standards.md](media-standards.md): frame-accurate cuts, A/V sync, loudness, colour tags,
caption timing and safe zones. Any ticket marked `Touches media: yes` has golden media tests.

### Privacy and data safety

- Nothing new leaves the machine unless [PRIVACY.md](../../PRIVACY.md) already allows it for that
  provider mode, or the PR updates PRIVACY.md and the PO accepts it.
- New network calls are listed with their host and purpose. Telemetry stays off by default.
- No code reads or writes T3 Code's data folder (`~/.t3`), its Electron profile or its browser
  storage. s7video data lives under its own folder.
- No client footage, client audio, CapCut library assets or other people's media in code, tests,
  fixtures, screenshots, logs or evidence.

### Secrets and keys

- API keys and tokens are stored through the secret store (the macOS Keychain for user keys), never
  in settings files, project folders, logs, error messages, telemetry or test snapshots.
- Secrets are never sent to the web client; redaction is covered by a test.
- Our own service keys never ship in the app.

### Security

- File system access follows the file system row of
  [baseline-risk-map.md](baseline-risk-map.md); paths from agents, the UI or project
  files are resolved and checked before use.
- New RPC methods and MCP tools declare their required scope and access level, with a test for the
  denied case.
- Subprocesses get argument arrays, never a shell string built from input.
- Electron: no new `nodeIntegration`, no widened preload surface without a reason, and remote content
  stays sandboxed.

### Performance

- No new work on the UI thread that scales with media length or project size.
- Scrubbing and preview use proxies; nothing re-encodes on a caption or style change.
- No continuously repainting animations. WebSocket payloads stay bounded.

### Licences and assets

- Every new dependency, font, icon, sound, model or sample clip is in the ticket's Licence & Assets
  table with a licence on the allowlist ([CONTRIBUTING.md](../../CONTRIBUTING.md#licences)).
- Model weights are downloaded on first run, never committed. Fonts carry their licence file.
- New files carry SPDX headers; files copied from T3 Code keep theirs.

### Theming and configuration

Apply [theming-and-config.md](theming-and-config.md): no hard-coded product name, colour, URL, bundle ID
or data path in new code.

### Accessibility

- New controls are reachable by keyboard, have an accessible name, and meet WCAG 2.2 AA contrast in
  both dark and light themes.
- Media controls (play, trim, accept or undo an edit) have keyboard shortcuts and VoiceOver labels.

### Tests

Apply [testing.md](testing.md). Every tier the ticket lists exists and passes; edge cases cover the
failure paths, not just the happy one; tests assert behaviour, not implementation details.

### Upstream hygiene

- Changes to files shared with T3 Code stay small, so monthly upstream merges stay cheap
  ([docs/FORK.md](../FORK.md)). Large rewrites of upstream files need a reason in the PR.
- Removed upstream features are recorded in `docs/FORK.md`.

### Commits

- Conventional Commits with the ticket ID, `Signed-off-by` matching the author, and the attribution
  line when an agent did the work. No `--no-verify` without a written reason in the ticket.
- The tree is clean and `ticket:finalize` passes.

## AI-generated code red flags

Look for these in every agent-written diff:

- Tests that cannot fail: asserting a mock was called with what the test passed it, snapshotting
  output the test just built, `expect(true)`, skipped or commented-out cases.
- Errors swallowed (`catch {}`, `Effect.orElse(() => Effect.void)` without a reason), or turned into
  success values.
- Dead code: unused exports, branches no input reaches, "for future use" parameters. `pnpm knip:check`
  catches some; read for the rest.
- Duplicated helpers that already exist in `packages/shared` or the owning package.
- Comments that narrate the change or restate the code instead of explaining a constraint.
- Invented APIs, flags or config keys that do not exist in the dependency version installed.
- Claims in the PR body or ticket Results that the diff or the gate output does not support.
- Timeouts, sleeps or retries added to make a flaky test pass.
