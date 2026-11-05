<!--
SPDX-FileCopyrightText: 2026 T3 Tools Inc.
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# s7video agent rules

These rules apply to Claude Code, Codex and every other agent working in this repo, and to people.
`CLAUDE.md` points here; this file is the single source of truth.

s7video is an MIT-licensed Mac app (Apple Silicon only) for editing short videos by chatting with an
agent. It is a fork of [T3 Code](https://github.com/pingdotgg/t3code): a Node/Effect server wraps
agent CLIs and serves a React web UI inside an Electron desktop app. The project is pre-alpha; today
the app is T3 Code with the s7video name and without its mobile, cloud and code-hosting parts
([docs/FORK.md](docs/FORK.md)). The editing features come in later sprints.

## Read first, in this order

1. **The ticket** you are working on: `$S7V_PLANNING_DIR/tickets/backlog/S7V-XXX-*.md`. The planning
   repo (`ideanavigator/s7video-planning`) lives beside this checkout; `S7V_PLANNING_DIR` overrides
   the default `../s7video-planning`. Tickets stay in
   `tickets/backlog/` for their whole life; the `Status` line in the file is the state.
2. **The sprint plan and sprint prompt** the ticket belongs to: `plans/sprints/NN-*.md` and
   `NN-*-prompt.md`. Their "Decisions" are settled; do not re-open them.
3. **The PRD and ADRs** the ticket names: `prds/PRD-XXX-*.md`, `decisions/ADR-XXX-*.md`.
4. **The planning rules:** `tickets/README.md` and `tickets/schema.md` in the planning repo.
5. **The code**, starting with the files the ticket's Technical Design names, and the standards in
   [docs/engineering/](docs/engineering/README.md).

## Plan before code

- **No code without a ticket in `ready`**, with no exceptions for agents. (The small-fix exception in
  [CONTRIBUTING.md](CONTRIBUTING.md) is for outside contributors; a maintainer files the ticket.) A new product area gets a PRD; a hard-to-reverse choice gets
  an ADR. Create them with `pnpm ticket:new` and `pnpm doc:new`; never pick a number by hand.
- A genuinely new problem found while working gets its own ticket, and you tell the developer. Do not
  quietly widen the ticket in front of you.
- Run the ticket's **Confidence: checks before build** first and record the results. If a check fails
  or shows the design will not hold, stop and report with evidence. Do not redesign silently.
- Do not commit plans, research notes or scratch files to this repo. They belong in the planning repo
  or outside the worktree. `.plans/` is gitignored only as a safety net.

## The per-ticket process

| Step             | What                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Branch        | From the current sprint branch (`sprint/S7V-XXX-slug`), not `main`: `feat/`, `fix/`, `docs/`, `chore/` or `spike/` + `S7V-XXX-slug`.                                                                                                                                                                                                       |
| 2. Status        | Set the ticket to `in-progress` in the planning repo and run its confidence checks.                                                                                                                                                                                                                                                        |
| 3. Build         | Code and every test tier the ticket lists ([testing.md](docs/engineering/testing.md)). Spikes never merge their code.                                                                                                                                                                                                                      |
| 4. Gates         | Run the [local gates](#run-the-gates-locally), including `pnpm test`, and the ticket's Verification Commands. Paste the output in the PR.                                                                                                                                                                                                  |
| 5. Changelog     | Write `docs/changelog/entries/S7V-XXX.md` and the `CHANGELOG.md` bullet ([docs/changelog](docs/changelog/README.md)).                                                                                                                                                                                                                      |
| 6. Commit        | [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with the ticket ID: `fix(timeline): S7V-123 captions no longer drift after a trim`. Always `git commit -s` (DCO). End with the attribution lines the session gives you, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.                      |
| 7. Planning repo | Once the branch is pushed for review (with its PR, when one is opened), tick the ACs you met, set `in-review`, add a Results section (branch, SHAs, gate output, ACs open with reasons), keep `tickets/test-map.json` in sync, run `pnpm ticket:validate -- S7V-XXX --strict`, commit there with the ticket ID, `git pull --rebase`, push. |
| 8. Pull request  | Into the sprint branch, using the [PR template](.github/PULL_REQUEST_TEMPLATE.md): ticket ID, confidence-check results, ACs met and open, gate output. Open it only when the sprint prompt or the developer asks for it.                                                                                                                   |
| 9. Review        | A **separate reviewer agent with fresh context** reviews the whole diff ([code-review-standards.md](docs/engineering/code-review-standards.md), [prompts](docs/engineering/ai-code-review-prompts.md)). The author session never reviews itself.                                                                                           |
| 10. Fix          | Answer every `[blocking]` and `[non-blocking]` finding with a fixing commit or a written reason. Critical and high findings always block.                                                                                                                                                                                                  |
| 11. Sign-off     | Only the reviewer posts `Review sign-off: <full head SHA>` and saves `code-reviews/S7V-XXX.md` in the planning repo. A new commit needs a new sign-off.                                                                                                                                                                                    |
| 12. Merge        | Run the gates on the signed-off head, post the output, then `gh pr merge <n> --squash --match-head-commit <SHA>`. `pnpm ticket:finalize -- S7V-XXX --skip-verify` must pass, then the ticket goes to `done` once its PM Experience Test has passed.                                                                                        |

`in-review` means the branch is pushed for review (with its PR, when the sprint prompt asks for one).
`done` means merged into the sprint branch with the reviewer's sign-off on the head SHA, a changelog
entry and a passed PM Experience Test. Never mark a ticket `done` without all three.
Never merge a sprint branch into `main` without the developer's approval.

## Never

- **Client footage or audio** (from any client, whoever they are), CapCut library
  sounds or effects, or anyone else's media anywhere in this repo: code, tests, fixtures, screenshots,
  logs, evidence or PR attachments. Test clips are ones we shot or CC0.
- **Secrets**: API keys, tokens, pairing URLs, `.env` values. Not in commits, logs, screenshots or
  replies.
- **T3 Code's data**: never read, write, migrate or clean up `~/.t3`, T3 Code's Electron profile or its
  browser storage. A developer's installed T3 Code is in use while you work. s7video's data belongs
  in its own folder (`~/.s7video`, development `~/.s7video/dev`; S7V-003).
- **A dependency or asset outside the licence allowlist** (summary in
  [CONTRIBUTING.md](CONTRIBUTING.md#licences); the full list and ADR-003 are in the planning repo).
  Anything not on it needs an ADR first. Model weights are downloaded, never committed.
- **Hard-coded brand values**: product name, colours, URLs, bundle ID, protocol, data paths. They come
  from config and theme tokens ([theming-and-config.md](docs/engineering/theming-and-config.md)).
- `--no-verify`, force-pushing a shared branch, rewriting a signed-off commit, or bare `git stash`
  (the stash is shared between worktrees; use a WIP commit).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a
   name, path or worktree string. Your own agent process has this worktree's path in its arguments,
   and the machine runs other dev servers and an installed T3 Code. Kill only a PID you captured at
   spawn, or the owner of your port from `lsof -nP -iTCP:<port> -sTCP:LISTEN` after confirming with
   `lsof -a -p <pid> -d cwd` that its working directory is your worktree.
2. **Writing to a live install.** `~/.t3/userdata` is the developer's real T3 Code database, and
   `~/.s7video` is their real s7video data. Never start a server against either, never open them
   read-write, never clean them up. Dev servers use the worktree's own gitignored state folder.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and
   Vite proxies `/api`, `/ws`, `/oauth` and `/.well-known`. Setting them bakes localhost into the
   bundle and breaks every other browser.

## Toolchain and dev servers

- `vp` ([Vite+](https://viteplus.dev/guide/)) installs, runs tasks and tests. It provides the Node
  version pinned in `package.json`. pnpm is the package manager (`npm i -g pnpm@12.14.0`).
- `vp i` installs. Worktrees get this from the `t3.json` setup script; if module resolution looks
  broken, it probably did not run. While `.t3/setup-running` names a live PID, wait for it; it ends
  with `.t3/setup-done` or `.t3/setup-failed`. With no marker at all, run `vp i` yourself.
- **Never touch `~/.t3`.** Not to read test data, not to write dev state, not to clean up.
- **The safe dev commands** keep dev state inside your checkout. Run them from the repo
  root of your checkout or worktree:

  ```bash
  vp run dev --no-seed --home-dir "$PWD/.t3"           # server and web UI
  vp run dev:desktop --no-seed --home-dir "$PWD/.t3"   # Electron app
  ```

  `--home-dir "$PWD/.t3"` keeps state in this checkout's gitignored `.t3` folder. Without it, a main
  checkout writes to `~/.t3/dev`, inside T3 Code's folder. `--no-seed` stops upstream from copying
  `~/.t3/userdata` into the new database. Never run `vp run migrate-dev-db`: it also reads `~/.t3`.
  Add other flags (such as `--browser`) after these. Build test data through the app or the
  replay provider. Read the real ports from the `[dev-runner]` line.

- Real agent turns cost money. Use the free `Replay (dev)` provider that `vp run dev` registers; the
  [test-app skill](.agents/skills/test-app/SKILL.md) shows how. Use a real provider only when
  the change depends on it, with its cheapest model.
- Stop what you started, by the PID you tracked. Need a second checkout? `git worktree add` it next to
  this one, not in `/tmp`, and remove it when done.

## Run the gates locally

There is no CI until Sprint 02 (S7V-009). Every gate runs by hand, by the author before the PR and by
the reviewer on the head commit.

| Gate                          | Command                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Format                        | `pnpm fmt:check` (fix with `pnpm fmt`)                                                                                                  |
| Lint                          | `pnpm lint`                                                                                                                             |
| Dead code and dependencies    | `pnpm knip:check`                                                                                                                       |
| Types                         | `pnpm typecheck` (cached per package; never `npx tsc`)                                                                                  |
| Focused tests                 | `vp test run <files>`, with `-t "<name>"` for one case                                                                                  |
| Fast checks for changed files | `vp run check:changed`                                                                                                                  |
| Full test suite               | `pnpm test`, required before every PR; failures that also fail on the base commit are listed in the ticket with the base SHA and output |
| Markdown links                | `pnpm docs:linkcheck`                                                                                                                   |
| Licence notices               | `pnpm licenses:sync`, `pnpm licenses:check` and `pnpm reuse:lint` (needs `uv`: `brew install uv`)                                       |
| Brand values                  | `pnpm brand:check`                                                                                                                      |
| Ticket structure              | `pnpm ticket:validate -- S7V-XXX --strict`                                                                                              |
| Ticket behaviour              | `pnpm ticket:verify -- S7V-XXX` (runs the test map)                                                                                     |
| Commit hygiene                | `pnpm ticket:finalize -- S7V-XXX --skip-verify`                                                                                         |
| Ticket board                  | `pnpm tickets`                                                                                                                          |

The pre-commit hook runs `vp staged` (format, lint, knip on staged files). Run `node -e` snippets
from `apps/server` or the owning package: `effect` does not resolve from the repo root.

## Writing tests

The full rules are in [docs/internals/testing.md](docs/internals/testing.md) and
[docs/engineering/testing.md](docs/engineering/testing.md). The ones that catch most mistakes:

- Test behaviour that can break: orchestration, provider protocol translation, auth and permission
  guards, persistence and migrations, external formats, media timing, and the logic a bug fix
  changed. Skip what types already guarantee, copy text and mock-call mirrors.
- Extend an existing test or table before adding one. Test at the lowest layer that fails on the base.
- A bug fix starts with a failing test (purely visual bugs get before and after screenshots instead).
- Never wait on sleeps, polling or wall-clock time. `it.effect` runs on a `TestClock`; drain the
  effect worker (`OrchestrationEffectWorkerV2.drain`) or await the persisted event or `Deferred`.
  No per-test timeouts or retries. Lint enforces this (`t3code/no-*` test rules).
- Web browser tests render with `await using screen = await render(...)` from
  `apps/web/test/render.tsx`.
- Tickets marked `Touches media: yes` need golden media tests
  ([media-standards.md](docs/engineering/media-standards.md)).

## How the code works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_
(`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without
doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command
receipt_ and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as
starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs
run as subprocesses; per-provider _adapters_ translate their protocols into orchestration events. Each
turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore. s7video's edits will
use the same checkpoints for undo.

Architecture: [docs/internals/overview.md](docs/internals/overview.md). Vocabulary:
[docs/internals/glossary.md](docs/internals/glossary.md).

### Where code lives

- `apps/server`: WebSocket, orchestration, providers, checkpointing. Effect-heavy; read
  [Effect services](docs/internals/effect-services.md) before adding server code.
- `apps/web`: the React/Vite UI. `apps/desktop` wraps it in Electron (shell, IPC, updater).
- `packages/contracts`: Effect Schema contracts for everything that crosses the wire. No heavy logic.
- `packages/shared`: shared runtime utilities, subpath exports, no barrel.
- `packages/client-runtime`: client code shared by web and desktop.
- `packages/provider-*`: the agent adapters s7video keeps (Codex, Claude, Antigravity and agents from
  the ACP registry).

### Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else.
Before calling UI work done, say which of these applied:

- **Entry points.** A behaviour reachable from the chat is usually also reachable from Settings, the
  command palette and a keybinding.
- **Clients.** Web and desktop (which wraps web and adds the Electron shell and IPC). Shared logic lives
  in `packages/client-runtime`.
- **Providers.** Codex, Claude, Antigravity and ACP agents each have an adapter. Provider-shaped
  features need a decision per adapter, even if it is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools.
  That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`.
- **Reverse states.** A way in needs a way out and a way to see it. Accept needs undo.
- **Connection modes.** Local and LAN or Tailscale connections behave differently.
- **Docs.** Check whether the change makes existing guidance or [PRIVACY.md](PRIVACY.md) wrong.

## Taste

- Ambitious ideas, simple systems. Do not keep complexity because it exists, or add machinery because
  it looks impressive. Fight scope creep; "measure twice, cut once" and "yagni".
- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Server features are services; transports stay thin. An RPC handler, HTTP route or MCP tool decodes
  input, calls one service method and maps errors.
- Client mutations use `createEnvironmentRpcCommand`. Protected methods go in
  `CLIENT_GUARDED_RPC_SCOPES` in contracts, with permission tests.
- `apps/web/src/components/ui` components own their look: pick a `variant` or `size`, do not restyle
  with `className` (`shadcn/no-restyle`). See [Web UI](docs/internals/web-ui.md).
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a
  function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction. Use
  `Effect.fnUntraced` only where spans would be too frequent, and say why nearby.
- Inferred types over annotations. No `any`.
- Default to no comment. Write one only for a constraint, an external quirk or an invariant the code
  cannot show, in four lines at most (`t3code/no-low-value-comments`).
- React effects are for synchronising with something outside React. Derive in render and act in
  handlers; an effect that stays states its reason (`t3code/no-unreasoned-state-sync`).
- Editors notice a dropped frame, a lying spinner and a stale label. No continuously repainting
  animations; keep the UI thread free of work that scales with media length.
- Keep changes to upstream files small so monthly upstream merges stay cheap ([docs/FORK.md](docs/FORK.md)).

## Documentation

- `docs/internals/` is for decisions, cross-component constraints and traps the code does not show.
  Do not narrate code, list fields or append PR summaries.
- `docs/user/` helps users do tasks, in the product's voice, without contributor tooling.
- `docs/operations/` holds maintainer setup, release and debugging procedures.
- `docs/engineering/` holds the standards; change them through a ticket.
- When a documented decision changes, rewrite or remove the old text rather than appending.

## When to stop and ask

Stop, write down what you found, and ask the developer when:

- a confidence check fails, or the ticket's design will not hold;
- the work needs something outside the ticket's scope, a new dependency not on the allowlist, or a
  decision a sprint plan or ADR already made;
- a rule here conflicts with the task in front of you (say so loudly, and get sign-off before
  breaking it);
- you would have to touch `~/.t3`, a live install, client media or a secret to continue;
- a gate fails on the base commit too and the ticket does not say how to handle it (record the
  failure with the base SHA in the ticket, then ask whether it blocks);
- free disk space is under 15 GB, or something destructive (deleting data, force-pushing, rewriting
  history) looks necessary.
