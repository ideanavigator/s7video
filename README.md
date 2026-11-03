<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# s7video

s7video is an open-source Mac app for editing short videos by chatting with an AI agent. You drop in
your raw clips, say what you want ("cut the pauses, add captions in my usual style"), and the agent
proposes an edit that you can review as a diff, play back, accept or undo. Projects stay on your
computer, and nothing leaves it unless you choose a cloud model.

s7video is a fork of [T3 Code](https://github.com/pingdotgg/t3code), the open-source desktop app for
coding agents. We keep its chat, threads, checkpoints and agent runtime, and build a video editor
around them.

> **Status: pre-alpha.** The editing features are not built yet. Today the app is T3 Code with the
> s7video name, without the parts we do not need (mobile app, hosted sign-in, code-hosting
> integrations). There are no releases; build it from source. Expect breaking changes.

_Screenshots will be added here with the first editing build._

## Requirements

- A Mac with Apple Silicon (M1 or later). Intel Macs, Windows and Linux are not supported.
- [pnpm](https://pnpm.io/) 12.14.0: `npm i -g pnpm@12.14.0`.
- The [Vite+](https://viteplus.dev/guide/) command-line tool `vp`: `curl -fsSL https://vite.plus | bash`.
  It provides the Node.js version pinned in `package.json`, so no separate Node install is needed.
- At least one coding-agent CLI installed and signed in, for example
  [Claude Code](https://claude.com/product/claude-code) (`claude auth login`) or
  [Codex CLI](https://developers.openai.com/codex/cli) (`codex login`). Until the editing features
  land, the agent is what you talk to.

## Quick start (development)

```bash
git clone https://github.com/ideanavigator/s7video.git
cd s7video
vp i                 # install dependencies
pnpm dev:desktop     # run the desktop app in development mode
```

`pnpm dev` runs the server and the web UI without Electron. The
[development runbook](docs/operations/development.md) covers the other commands, tests and local
desktop builds.

## Project status and plans

| Phase                  | What                                                                      | State       |
| ---------------------- | ------------------------------------------------------------------------- | ----------- |
| Sprint 01: Foundations | Fork, branding, licences, community files, engineering rules              | In progress |
| Sprint 02: Automation  | CI gates, branch protection, signed releases                              | Planned     |
| Feature phases         | Editing engine, player and timeline, chat edits, styles, projects, review | Planned     |

How work is planned, and how to propose something, is in [docs/planning.md](docs/planning.md).
Notable changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: every change starts from a
ticket, commits follow Conventional Commits, and every commit needs a DCO sign-off
(`git commit -s`). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

- Questions and help: [SUPPORT.md](SUPPORT.md)
- Security problems: [SECURITY.md](SECURITY.md) (please do not open a public issue)
- What the app sends off your computer: [PRIVACY.md](PRIVACY.md)
- Who decides, and the licence commitment: [GOVERNANCE.md](GOVERNANCE.md)
- Using the name and logo: [TRADEMARK.md](TRADEMARK.md)
- How this fork differs from T3 Code: [docs/FORK.md](docs/FORK.md)

## Credits

s7video is built on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., released under
the MIT licence. Thank you to everyone who built it. s7video is an independent
project and is not affiliated with or endorsed by T3 Tools Inc.

The licences of bundled third-party software are in [third-party-licenses/](third-party-licenses).

## Licence

s7video is released under the [MIT licence](LICENSE), the same licence as T3 Code. The s7video name
and logo are not covered by the licence; see [TRADEMARK.md](TRADEMARK.md).
