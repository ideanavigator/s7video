<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Changelog process

Every ticket that changes the app gets a changelog entry before it is `done`. The planning repo's
`ticket:validate` refuses a `done` ticket without one.

```
docs/changelog/
  README.md          this file
  entries/
    S7V-002.md       one file per ticket, kept permanently
    S7V-006.md
    ...
CHANGELOG.md         the compiled changelog at the repo root (Keep a Changelog 1.1)
```

## Writing an entry

When a ticket is ready for review, copy the **Changelog Entry** block from the ticket into
`docs/changelog/entries/S7V-XXX.md`, fill it in, and add a `Section` line:

```markdown
### Short title a user would understand

- **Ticket:** S7V-XXX
- **Section:** Added
- **What:** What changed, from the user's point of view.
- **Why:** Why it matters to them.
```

| Field     | Rule                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Title     | The ticket's changelog title. Plain language, no code words.                                                                  |
| `Ticket`  | Exactly one ticket ID. A change that spans tickets gets one entry per ticket.                                                 |
| `Section` | One [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) section: Added, Changed, Deprecated, Removed, Fixed or Security. |
| `What`    | One or two sentences. Name the visible change, not the files.                                                                 |
| `Why`     | One sentence on the benefit.                                                                                                  |

Usual sections by ticket type: Feature → Added, Enhancement → Changed, Bug → Fixed, Tech Debt →
Changed or Removed. A fix for a vulnerability goes under Security, and its entry is written only once
the advisory is public. Spikes are never merged, so they have no entry. Breaking changes start the
`What` line with **Breaking:** and say what users must do.

Entries are written in the same pull request as the change, and are never edited once the ticket is
`done`; a later correction is a new ticket with its own entry.

## Compiling `CHANGELOG.md`

`CHANGELOG.md` keeps an `[Unreleased]` section. When a ticket lands, add one bullet for it under the
matching section there, ending with the ticket ID in parentheses:

```markdown
### Added

- Community and governance files: README, contributing guide, ... (S7V-006)
```

On release, `[Unreleased]` is renamed to the version and date (`## [0.2.0] - 2026-12-01`) and a new,
empty `[Unreleased]` starts above it. Versions follow [SemVer 2.0](https://semver.org/spec/v2.0.0.html):
before 1.0, a breaking change bumps the minor version and everything else the patch version. Entry
files stay in `entries/` after a release; they are the per-ticket record the planning scripts check.
