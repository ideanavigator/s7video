<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# How s7video is planned

This page summarises how work on s7video is planned and tracked. The detailed plans, tickets and
review records live in a separate planning repository, `ideanavigator/s7video-planning`, which is
private for now. Everything a contributor needs to
follow the process is on this page and in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Plan before code

Nothing is built without the documents above it in this chain:

```
Production plan ─┐
PRD             ─┼─▶ Sprint plan ─▶ Tickets ─▶ Pull requests ─▶ Independent review ─▶ Changelog
ADR             ─┘
```

| Document     | Answers                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| Product plan | What we are building, the architecture, the phases and the risks            |
| PRD          | Who a product area is for, what it does and how we measure success          |
| ADR          | A decision that is hard to reverse, and why we made it                      |
| Sprint plan  | Which tickets a sprint takes on, in what order, and its exit checks         |
| Ticket       | The spec for one change: acceptance criteria, design, tests, licence checks |
| Code review  | An independent reviewer's findings and sign-off on the exact commit         |
| Changelog    | What changed for users, per ticket, in [CHANGELOG.md](../CHANGELOG.md)      |

Ticket IDs look like `S7V-012`. Every branch, commit and pull request names the ticket it belongs to.

## Ticket lifecycle

```
draft → ready → in-progress → in-review → done
```

| Status        | Meaning                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `draft`       | Being written                                                                                  |
| `ready`       | Fully specified and in a sprint; anyone can pick it up                                         |
| `in-progress` | Being built; its confidence checks run before any code                                         |
| `in-review`   | Branch pushed (with its pull request), acceptance criteria met, waiting for independent review |
| `done`        | Merged after reviewer sign-off on the head commit, with a changelog entry written              |

## Key decisions

| Decision                                                                                                                                  | Record  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| The whole app is MIT, like T3 Code. The desktop app, engine, skills and starter style packs stay MIT ([GOVERNANCE.md](../GOVERNANCE.md)). | ADR-001 |
| The Claude Agent SDK ships as T3 Code ships it; s7video has no "Sign in with Claude" of its own.                                          | ADR-002 |
| The licence allowlist for dependencies and assets, summarised in [CONTRIBUTING.md](../CONTRIBUTING.md#licences).                          | ADR-003 |

## Roadmap

| Phase                  | Goal                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Sprint 01: Foundations | Fork T3 Code, strip what we do not need, brand it, licences, community and agent rules |
| Sprint 02: Automation  | CI gates, branch protection, signed and notarised releases, supply-chain checks        |
| Engine as skills       | Transcription, cuts, captions and rendering as tools the agent can call                |
| Player and timeline    | Preview with proxies, a simple timeline, frame-accurate playback                       |
| Chat edits video       | The agent proposes edits as diffs you can play, accept or undo                         |
| Styles and references  | Reusable style packs, and importing a style from a reference video                     |
| Projects and review    | A project library, versions and timestamped review comments                            |
| Hardening and launch   | Performance, accessibility, signed builds and the first public release                 |

## Proposing work

Outside contributors do not need access to the planning repository:

- **Bugs:** open a [bug report](https://github.com/ideanavigator/s7video/issues/new?template=bug.yml).
- **Ideas and features:** open a
  [feature request](https://github.com/ideanavigator/s7video/issues/new?template=feature.yml).
  A maintainer turns accepted ideas into a ticket and links it from the issue.
- **Small fixes** (typos, an obvious one-line bug) can go straight to a pull request.

Anything larger waits until a maintainer has linked a ticket in `ready` from the issue. That keeps
your work from clashing with a sprint already in progress.
