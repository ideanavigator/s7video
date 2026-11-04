<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT

Read CONTRIBUTING.md first. Title: Conventional Commits with the ticket ID, in plain language,
for example "fix(timeline): S7V-123 captions no longer drift after a trim".
Never include client footage, other people's media, API keys or sign-in tokens.
-->

## Ticket

S7V-

<!-- Link the ticket or the issue that links it. Small obvious fixes without a ticket: say why it qualifies. -->

## What changed and why

<!-- One or two sentences on the problem, then how this fixes it. -->

## Acceptance criteria

<!-- List each AC from the ticket: met, or open with the reason. -->

## Tests

<!-- The tests you added or changed, per tier (unit, edge cases, end to end, golden media when the
change touches media), and the commands you ran with their results. State what you could not check. -->

- [ ] `pnpm fmt:check`
- [ ] `pnpm lint`
- [ ] `pnpm knip:check`
- [ ] `pnpm typecheck`
- [ ] Focused tests: `vp test run <files>`

## Screenshots

<!-- UI changes: before and after, dark and light themes. Motion or timing: a short recording.
Upload to GitHub; do not commit them. Delete this section if there is no UI change. -->

## Licences and data

- [ ] No new dependencies, fonts, icons, sounds, models or sample media; **or** each one is listed
      below with its licence and is on the allowlist in CONTRIBUTING.md.
- [ ] No client footage, CapCut or other editors' library assets, secrets or personal data anywhere
      in the diff, tests or screenshots.
- [ ] New source files have SPDX headers.
- [ ] Every commit is signed off (`git commit -s`).

| Item | Licence | Bundled or downloaded |
| ---- | ------- | --------------------- |
|      |         |                       |

<!-- If an agent did the work, end with the model and harness, for example
"Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". -->
