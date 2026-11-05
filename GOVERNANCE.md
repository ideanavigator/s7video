<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Governance

s7video is a young project with a single maintainer. This page says who decides, how decisions are
made and recorded, how others become maintainers, and what we promise about the licence.

## Maintainers

| Name            | GitHub             | Role                           |
| --------------- | ------------------ | ------------------------------ |
| Shashwat Aditya | `@shashwat-aditya` | Project lead and product owner |

Maintainers review and merge pull requests, triage issues, write and accept tickets, and cut
releases. The project lead has the final say when maintainers disagree.

## How decisions are made

Decisions are written down before code is written (see [docs/planning.md](docs/planning.md)):

- **Product direction** for an area is set in a PRD (product requirements document).
- **Hard-to-reverse choices**, such as a licence, a core dependency or a file format, get an ADR
  (architecture decision record) that states the context, the decision, its consequences and the
  alternatives considered.
- **Individual changes** are specified in tickets and accepted by a maintainer before work starts.

Anyone can propose a change to any of these through an issue. Maintainers aim for consensus; when
there is none, the project lead decides and records the reason in the ADR or ticket. Accepted ADRs
are only replaced by a new ADR, never edited away.

## Becoming a maintainer

A contributor can be invited to become a maintainer after a sustained record of good work, typically:

- several merged pull requests across more than one area, each with tests and clean reviews;
- careful, helpful reviews of other people's pull requests;
- following the [Code of Conduct](CODE_OF_CONDUCT.md) and the rules in
  [CONTRIBUTING.md](CONTRIBUTING.md).

Any maintainer can nominate a contributor. The project lead confirms, the new maintainer is added to
the table above and to [.github/CODEOWNERS](.github/CODEOWNERS), and the change is announced in the
pull request that adds them. Maintainers who are inactive for six months, or who ask to step down,
become emeritus and lose merge rights; they can return through the same process.

## Licence commitment

s7video is released under the [MIT licence](LICENSE), the same licence as T3 Code (ADR-001). We
commit that:

- **The desktop app, the editing engine, the agent skills and the starter style packs stay MIT.**
  We will not move them to a more restrictive licence, a source-available licence or a closed
  product.
- The local and bring-your-own-key ways of using the app stay in the free app and will not be
  deliberately crippled to sell a paid plan.
- Contributions are accepted under the MIT licence with a [DCO](https://developercertificate.org/)
  sign-off. There is no contributor licence agreement, so contributors keep their copyright and we
  cannot relicense their work.

Hosted services that the project may run later, such as a paid cloud model proxy or a style
marketplace, can be closed source. They are separate from the app and are not covered by this
commitment. Using the app never requires them.

Code already released under MIT stays available under MIT in any case; the MIT licence cannot be
withdrawn from a release.

## Trademarks

The code is MIT, but the s7video name and logo are not. See [TRADEMARK.md](TRADEMARK.md).
