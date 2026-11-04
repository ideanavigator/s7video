<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Contributing to s7video

Thank you for helping. s7video is pre-alpha, so the rules below are short but strict: every change
is planned, tested, signed off and reviewed. By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need an Apple Silicon Mac, `vp` and pnpm; see the [README](README.md#requirements). Then:

```bash
git clone https://github.com/ideanavigator/s7video.git
cd s7video
vp i
vp run dev:desktop --home-dir ~/.s7video-dev --no-seed
```

The two flags keep dev state out of `~/.t3`, the folder an installed T3 Code uses, until S7V-003
gives s7video its own data folder.

The [development runbook](docs/operations/development.md) has the other dev commands, where dev data
is stored, and how to build the desktop app locally.

## Start from a ticket

Every change belongs to a ticket (`S7V-123`). Tickets are written before any code and carry the
acceptance criteria and tests that prove the change. How planning works, and how to propose a bug or
an idea, is in [docs/planning.md](docs/planning.md).

- Bugs and ideas start as GitHub issues. A maintainer links a ticket once the work is accepted.
- Wait for a ticket in `ready` before starting anything beyond a small, obvious fix.
- Keep one ticket per pull request. Split unrelated fixes.

## Branches and commits

Branch names: `feat/`, `fix/`, `docs/`, `chore/` or `spike/`, then the ticket ID and a short slug,
for example `fix/S7V-123-caption-drift`.

Commit messages follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/) and
name the ticket, in plain language:

```
fix(timeline): S7V-123 captions no longer drift after a trim
```

### Sign off every commit (DCO)

We use the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a
contributor licence agreement. Signing off states that you wrote the change, or otherwise have the
right to submit it under the project's licence. Add the sign-off with `-s`:

```bash
git commit -s -m "fix(timeline): S7V-123 captions no longer drift after a trim"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line that must match the commit author.
Sign-off is required: maintainers check it by hand now, and it is enforced automatically from
Sprint 02 (S7V-010). To sign off commits you already made, run
`git rebase --signoff main` and force-push your branch.

If an AI agent helped, say so with a `Co-Authored-By:` line. You still sign off, and you are
responsible for the change.

## File headers

New source files start with an [SPDX](https://spdx.dev/learn/handling-license-info/) header
([REUSE 3.x](https://reuse.software/spec/)):

```ts
// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
```

Use the comment style of the file type (`#` in YAML and shell, `<!-- -->` in Markdown). Files copied
from T3 Code keep their original notice; do not add a second one.

## Licences

s7video is MIT. Every new dependency, font, icon, sound, model or sample clip must have one of these
licences, and the pull request must list it with its licence:

| Allowed                                                                        | Condition                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| MIT, MIT-0, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, Zlib, 0BSD, Unlicense | Keep their notices in `third-party-licenses/`                   |
| BlueOak-1.0.0, Python-2.0, PSF-2.0, CNRI-Python, Unicode-3.0                   | Same as above                                                   |
| MPL-2.0                                                                        | Unmodified, or our changes to those files published             |
| LGPL-2.1, LGPL-3.0                                                             | Dynamically linked only (for example an LGPL build of FFmpeg)   |
| OFL-1.1                                                                        | Fonts, each with its licence file                               |
| CC0-1.0, CC-BY-4.0                                                             | Sounds, images and sample clips; CC-BY needs attribution        |
| GPL-3.0 with the GCC Runtime Library Exception                                 | Unmodified compiler runtime libraries inside pre-built binaries |

**Not allowed:** GPL, AGPL, SSPL, BUSL, Elastic, Commons Clause, non-commercial or no-derivatives
Creative Commons licences, "free for personal use" terms, and anything with an unknown or missing
licence. Dual-licensed packages are used under their permissive option. Anything else needs a
maintainer decision before you use it.

Model weights are downloaded on first run and never committed.

**Never commit:** client footage or audio, assets from CapCut or other editors' libraries, API keys
or other secrets, or prompts and screenshots that contain someone else's content. Test clips are ones
you shot yourself or CC0 clips.

## Before you open a pull request

Run the checks locally (there is no CI yet):

```bash
pnpm fmt:check
pnpm lint
pnpm knip:check
pnpm typecheck
vp test run <changed test files>
```

Then fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md): the ticket ID, what
changed, the tests you added and ran with their output, the licence checklist, and screenshots in
dark and light themes for UI changes.

## How review works

- Every pull request is reviewed by someone other than its author. For agent-written work, that is a
  separate reviewer session with fresh context, never the session that wrote the code.
- Review comments start with `[blocking]` or `[non-blocking]`. Each one gets a fixing commit or a
  written reason.
- Blocking findings must be fixed before merge. The reviewer approves by posting
  `Review sign-off: <full head commit SHA>`; a new commit needs a new sign-off.
- Pull requests are squash-merged once signed off and the checks pass on that exact commit.

## Security and conduct

Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
Report conduct problems to the address in the [Code of Conduct](CODE_OF_CONDUCT.md).
