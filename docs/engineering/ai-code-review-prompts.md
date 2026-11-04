<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# AI code review prompts

Copy-paste prompts for starting an independent reviewer agent. Each one runs in a fresh session that
did not write the code. Replace `S7V-XXX`, `<base>` and `<head>`; the planning repo is at
`$S7V_PLANNING_DIR`, by default `../s7video-planning`.

Start every review with the base prompt, then add the focused prompts for the areas the diff touches
(see [baseline-risk-map.md](baseline-risk-map.md)).

## Base ticket review

```text
You are the independent reviewer for ticket S7V-XXX in the s7video app repo. You did not write this
code. Review the whole diff <base>..<head> against:
- the ticket: $S7V_PLANNING_DIR/tickets/backlog/S7V-XXX-*.md (ACs, Technical Design, Test Plan,
  Licence & Assets, Out of Scope);
- AGENTS.md and docs/engineering/code-review-standards.md;
- docs/engineering/baseline-risk-map.md for every area the diff touches.

Do this:
1. Read every changed file in full, not only the hunks. For deleted files, check nothing still
   imports or links to them.
2. Run the gates yourself on <head>: pnpm fmt:check, pnpm lint, pnpm knip:check, pnpm typecheck,
   the ticket's Verification Commands and the tests for changed files. Paste the results.
3. Check each AC against the code and the gate output. Do not trust ticks or the Results section.
4. Report findings as a table: #, severity (critical/high/medium/low), [blocking]/[non-blocking],
   file:line, finding, concrete fix. Critical and high always block.
5. List the points you checked and found correct, so the next reviewer knows what was covered.
6. Fill the Standards Applied list from code-reviews/TEMPLATE.md, writing N/A with a reason where a
   line does not apply.
7. Write the artifact to $S7V_PLANNING_DIR/code-reviews/S7V-XXX.md. Post
   "Review sign-off: <full head SHA>" only if there are no open blocking findings.

Do not fix the code yourself. Do not soften a finding because it is inconvenient.
```

## Re-review after fixes

```text
You are re-reviewing S7V-XXX. The previous review is in $S7V_PLANNING_DIR/code-reviews/S7V-XXX.md,
signed off (or not) on <old head>. The author answered in "Response to findings" and pushed
<old head>..<head>.
For each finding: confirm the fixing commit really fixes it (read the code, re-run the test), or
judge whether the written reason is acceptable. Diff any restored or ported test against its
original to check no assertion was weakened. Review the new commits for new problems with the same
standards. Append a "Re-review" section with a verdict per finding, new findings (R1, R2, ...), and a
new sign-off line on <head> if nothing blocking remains.
```

## Privacy and data safety

```text
Focus on what can leave the user's machine and what s7video can touch on disk.
- List every new or changed network call: host, trigger, payload. Compare with PRIVACY.md for each
  provider mode (installed CLI agent, local, bring your own key, s7video Cloud).
- Check telemetry is still off by default with no default destination.
- Check nothing reads or writes T3 Code's data (~/.t3, its Electron profile, its browser storage).
- Check no raw footage or audio is uploaded; only transcripts, edit plans and small sampled frames
  may be sent, and only in modes that allow it.
- Check fixtures, snapshots, screenshots and logs contain no client media, personal data or keys.
```

## Secrets and keys

```text
Trace every secret the diff touches (API keys, tokens, pairing credentials) from where it is entered
to where it is stored and used. Fail the review if a secret can reach: settings.json, a project
folder, a log line, an error message, a telemetry event, the web client unredacted, a test snapshot,
or a command line visible in the process list. User keys belong in the macOS Keychain; our own
service keys never ship in the app.
```

## File system and process safety

```text
For every path the diff reads or writes, say where the path comes from (user, agent, project file,
config) and how it is checked. Look for path traversal (.., symlinks, absolute paths), writes to
original media, temp files that are never removed, and subprocesses started with shell strings.
Check cancellation kills only processes this code started.
```

## Media correctness

```text
Apply docs/engineering/media-standards.md. For each media-affecting change, check: cut points land on
the intended frames at the project frame rate; audio stays in sync after cuts, speed changes and
concatenation; loudness and true peak meet the export target; colour tags (primaries, transfer,
matrix, range) are carried or set explicitly; caption timing and safe zones hold for 9:16, 1:1 and
16:9. Confirm golden media tests exist for "Touches media: yes" and that their tolerances were not
loosened to make them pass.
```

## Edit document and migrations

```text
For changes to edit.json, its schema, checkpoints or the app database: confirm the schema version is
bumped when the shape changes, a forward migration exists, a test opens a document or database from
the previous version, and undo/redo still restore the exact prior state. Released migrations must
not be edited.
```

## Test quality

```text
For each test the diff adds or changes: could it fail if the feature broke? Flag tests that assert
mocks echo their inputs, snapshot what they just built, sleep or poll, raise timeouts, or skip
without a tracking ticket. Check every tier the ticket lists exists (unit, edge cases, E2E, golden
media when it touches media, UX screenshots for UI) and that edge cases cover the failure paths the
ticket names. Check that tests removed from kept code were ported, not dropped.
```

## Dependencies and licences

```text
For every new or upgraded dependency, font, icon, sound, model or sample: give its licence from the
package itself (not from memory), check it against the allowlist in CONTRIBUTING.md, check it is in
the ticket's Licence & Assets table, and check its notice reaches third-party-licenses/. Flag model
weights or media committed to the repo, and any CapCut or client asset.
```

## UI, theming and accessibility

```text
Check new UI against docs/engineering/theming-and-config.md: no hard-coded product name, colour, URL
or font; colours come from theme tokens. Check dark and light screenshots at 1440x900 and 1180x760
are attached. Check keyboard access, accessible names, focus order and WCAG 2.2 AA contrast.
```
