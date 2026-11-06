<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# s7video fork of T3 Code

s7video is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT, © 2026 T3 Tools Inc.).

|                     |                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------- |
| Upstream repository | `https://github.com/pingdotgg/t3code` (remote `upstream`, push disabled)           |
| Base commit         | `47f2c8d29e981c7723467efe137ee19e91df924e` (`main`, 2026-11-02)                    |
| Fork repository     | `https://github.com/ideanavigator/s7video` (remote `origin`)                       |
| Strip ticket        | S7V-002, commit `fc18985cd` `chore(fork): S7V-002 remove unused apps and packages` |

The removals live in one commit so upstream merges stay reviewable: everything the fork deleted can
be read in that single diff.

## Removed in S7V-002

| Removed                                                                                                                                                                                                 | Why                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`, `apps/marketing`                                                                                                                                                                         | s7video is a Mac desktop app; no phone client or marketing site.                                                                      |
| `packages/provider-{cursor,fx,grok,muse,opencode,pi}`                                                                                                                                                   | Not needed; Cursor and Muse also pulled proprietary or extra SDKs (`@cursor/sdk`, `@muse-code/sdk`). Re-add per provider if wanted.   |
| `packages/source-control-{github,gitlab,bitbucket,azure-devops,forgejo,gitcafe}`                                                                                                                        | No code-hosting integrations. Local git (checkpoints, diffs, worktrees) does not depend on them.                                      |
| `packages/secret-provider-onepassword`                                                                                                                                                                  | No external secret stores; the 1Password settings dialog went with it.                                                                |
| `.repos/` (vendored alchemy-effect and effect-smol, ~21,800 files, 205 MB) and `sync:repos`                                                                                                             | Read-only reference copies, never imported.                                                                                           |
| `@cursor/sdk`, `@muse-code/sdk`, `@opencode-ai/sdk` in `apps/server`; Cursor binary staging in `scripts/build-desktop-artifact.ts`, `scripts/lib/cli-external-packages.ts`, `publicHoistPattern`        | Only used by the removed providers.                                                                                                   |
| Mobile scripts (`mobile-*`, `export-android-icons`, `screenshots:mobile`, `lint:mobile`, ...), mobile CI workflows, `mirror-play-apk.cjs`, the `test-t3-mobile` agent skill, the About → Mobile app row | Only served the mobile app.                                                                                                           |
| Mobile-only `pnpm-workspace.yaml` entries (catalog, overrides, patches, `allowBuilds`, release-age exclusions) and their `patches/*.patch` files                                                        | No longer in the dependency graph.                                                                                                    |
| Provider replay fixtures, testkits and tests for the removed providers                                                                                                                                  | Exercised removed code only. Some generic ACP adapter and usage tests that were written with Grok, Pi or Muse helpers went with them. |
| Tests that exercised GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo or GitCafe behaviour (URL parsing, PR linking and sync, host secrets, forks, stacks) in server, client-runtime, web and evals     | With no host registered they fail or wait forever (`PullRequestSyncReactor.test.ts` hung). Generic cases in the same files stay.      |

Wiring that changed rather than disappeared:

- `apps/server/src/provider/builtInDrivers.ts` registers Codex, Claude, Antigravity and the ACP registry.
- `packages/source-control-definitions` and `packages/secret-provider-definitions` build empty registries.
  The source-control settings page still shows local Git; the host list is empty.
- Credential fields of the removed hosts (`github.tokens`/`signIns`, `gitcafe.token`,
  `bitbucket.accessToken`/`apiToken`) and OpenCode's `serverPassword` stay registered as secret fields
  (`sourceControlHostSecrets.ts`, `settingsSecrets.ts`), so a stale credential in an upstream
  `settings.json` still moves to the secret store and is never sent to clients.
- The secrets settings page (behind `T3CODE_FEATURE_SECRETS`) lists saved secret providers as
  unsupported, with Remove only.
- `AgentSessionScanner` keeps importing Pi session transcripts when a stale enabled `pi` instance
  exists in settings (it inlines the 10-line session-dir lookup that lived in `provider-pi`).
  New Pi instances cannot be created.

## Old settings keep loading

`packages/contracts` treats provider driver kinds, source-control host keys and secret-provider kinds
as open strings, so a `settings.json` from T3 Code that names `cursor`, `github`, `one_password` and so
on still decodes. Unknown entries round-trip untouched; the server has no driver for them, so they do
nothing, and the secrets page lists stale secret providers as unsupported with a Remove button.
Covered by `packages/contracts/src/settings.test.ts` ("ServerSettings from upstream T3 Code").

## Deliberately kept

| Kept                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/source-control-core`, `source-control-definitions`                                                                                                                                                                            | Local git, checkpoints, PR-link parsing and settings types import them.                                                                                                                                                                                                                  |
| `packages/source-control-testing`                                                                                                                                                                                                       | Imported by 3 kept server test files (`PullRequestService`, `SourceControlProviderRegistry`, `SourceControlDiscovery`; about 100 cases).                                                                                                                                                 |
| `native/resource-monitor`                                                                                                                                                                                                               | The server's resource telemetry runs it on macOS.                                                                                                                                                                                                                                        |
| `native/hyprland-snap-shot`, `native/kde-snap-shot`, `apps/desktop/gnome-extension`, `dist:gnome-extension`                                                                                                                             | Linux snap-shot capture; wired into desktop snap-shot code, contracts IPC and web settings. Not self-contained.                                                                                                                                                                          |
| Exports in kept packages that only removed code used                                                                                                                                                                                    | Listed under `ignoreIssues` in `knip.jsonc`. Deleting them would turn every upstream change to those files into a conflict. Prune them only together with upstream. Since 2026-11-03 those files are not checked for new dead exports; S7V-009 replaces this with a per-symbol baseline. |
| Inert code keyed on removed provider names (`"cursor"`, `"grok"`, `"opencode"`, `"pi"`, `"muse"`, `"fx"`), e.g. provider status caching, model manifest entries, usage provider lists and the Cursor Keychain section of the Usage page | No driver reports these kinds, so the branches never run. Kept on purpose so upstream merges apply cleanly.                                                                                                                                                                              |
| Mobile-only lint rules in `oxlint-plugin-t3code`                                                                                                                                                                                        | Inert without `apps/mobile`; they carry their own tests.                                                                                                                                                                                                                                 |
| `@clerk/*` (except the mobile-only `@clerk/expo` catalog entry), `infra/*`, telemetry                                                                                                                                                   | Out of scope here; see below.                                                                                                                                                                                                                                                            |

## Changed later

| Ticket            | Scope                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| S7V-015           | Done: T3 cloud removed (see below).                                                    |
| S7V-013           | Done: usage data off by default and opt-in (see below). Kept in the code, not removed. |
| S7V-014           | Done: `heic-to` (LGPL) replaced by macOS HEIC decoding (see below).                    |
| S7V-003           | Done: branding from `s7video.config.ts`, own data folder, no T3 endpoints (see below). |
| S7V-004           | Licence notices.                                                                       |
| S7V-006 / S7V-008 | Done: community files and agent rules (see below).                                     |

## Removed in S7V-015

Clerk sign-in, T3 Connect, the managed relay and tunnel, DPoP tokens, guest share links, `t3 connect`,
hosted-app pairing links, `infra/relay` and `infra/task-cache` are gone. The kept code that still
contacted T3's servers now reads its endpoints from the brand config; see
[Still contacts T3](#still-contacts-t3).

| Area             | Removed                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop          | Clerk bridge and token store, passkey stack, relay-telemetry IPC, Clerk CSP hosts, `@clerk/electron*`, `electron-webauthn`, `electron-store`, `tldts`. Signed macOS builds now use fixed hardened-runtime entitlements with no provisioning profile, team ID or associated domains. |
| Web              | `src/cloud/`, `components/clerk/`, `components/cloud/`, `/connect` page, Connect onboarding, guest share controls, the `app.t3.codes` hosted-app default (pairing and prompt links), `@clerk/*`, `jose` (the server still uses it for Codex sign-in).                               |
| Server           | `cloud/` cloud modules, `relay/`, `guest/`, DPoP and replay markers, `t3 connect`, cloud routes and tunnel startup. `t3 up`/`t3 status` are LAN-only.                                                                                                                               |
| client-runtime   | `relay/`, relay discovery, DPoP token store, relay routes in the connection layer.                                                                                                                                                                                                  |
| contracts/shared | `relay.ts`, `relayClient.ts`, guest stream, connect HTTP API group, relay/DPoP/connect helpers in shared.                                                                                                                                                                           |
| Workflows        | Clerk, relay and provisioning-profile inputs; jobs that read `infra/relay`.                                                                                                                                                                                                         |

### Kept, with reasons

| Item                                                                                                                                                  | Why                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/cloud/{bootService,pinnedRuntime,serviceProtocol,serviceLauncherClient,serviceProtection,servicePreflight,selfUpdate,npmRelease}.ts` | Local boot service, pinned runtime and self-update. None import cloud code; their release source comes from the brand config (below). The folder name is historical. |
| `DesktopClerk.ts` → `DesktopLaunchLinks.ts`                                                                                                           | Deep links, single-instance lock, early user-data path and ChatGPT sign-in handoff lived in the same file.                                                           |
| Auth scopes `relay:*`, session method `dpop-access-token`, token type `DPoP` in contracts                                                             | They are in stored sessions. Old proof-bound sessions are now rejected.                                                                                              |
| Guest-share orchestration events, decider and projection; scheduled-task relay delivery fields; migration 058                                         | They are in the persisted event log and database. Inert.                                                                                                             |
| Machine kind `"cloud"`                                                                                                                                | Means a cloud VM, not T3's cloud.                                                                                                                                    |
| `cloud-connect` pairing subject, `ScheduledTaskWebhookOrigin.relayHookBaseUrl`, `DESKTOP_UPDATE_RESTART_MARKER_FILE`                                  | Inert: nothing issues or reads them. Revoking old `cloud-connect` sessions would write to T3 Code's session store.                                                   |
| Pending guest messages in old threads                                                                                                                 | Nothing can dismiss them now, so such a thread stays waiting. Only possible with T3 Code's data (see Old data).                                                      |

### Old data

Since S7V-003 s7video has its own data folder (`~/.s7video`, dev `~/.s7video/dev`), Electron profile
(`s7video`, `s7video-dev`), app id, URL scheme, CLI shim, boot-service label and socket folder. It
never reads or writes T3 Code's `~/.t3`, profiles or browser storage, so the shared-catalog effect
S7V-015 recorded is gone. The read-side tolerance below stays for upstream merges and costs nothing:

- Old catalogs drop T3 Connect routes, learned Connect profiles, their credentials and
  `remoteDpopTokens` in memory only, and every write keeps an empty `remoteDpopTokens` list.
- Old Clerk token files, the `t3code:cloud-auth` IndexedDB, `__clerk*` keys and the Connect opt-out flag
  are never read.
- Old cloud secrets in the secret store are never read. A test scans the server source for every
  retired secret name and prefix.
- `guestSharingEnabled` in old settings decodes and is dropped.

### Still contacts T3

Nothing T3 owns is contacted by default. S7V-003 moved every endpoint below into
`s7video.config.ts`, where an empty value turns it off:

| Path                                                        | Before                                                    | Now                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `telemetry/AnalyticsService.ts`                             | T3's PostHog ingest, on by default                        | `telemetry.host`/`key`, empty: sends nothing. Off unless opted in (S7V-013).     |
| `cloud/npmRelease.ts`, polled by clients every 5 minutes    | npm package `t3`                                          | `updates.npmPackage`, empty: no lookup, reports no release.                      |
| `cloud/pinnedRuntime.ts`, `selfUpdate.ts`, `bootService.ts` | `t3` binaries from `github.com/pingdotgg/t3code/releases` | `updates.githubRepository`, empty: install fails before any download.            |
| `cloud/servicePreflight.ts`                                 | `curl https://t3.codes/install.sh`                        | `updates.installScriptUrl`, empty: names `urls.repository` instead.              |
| `cli/update.ts`                                             | `api.github.com/repos/pingdotgg/t3code`                   | `updates.githubRepository`, empty: fails with "has no release feed".             |
| `provider/ModelManifest.ts` (hourly)                        | `raw.githubusercontent.com/pingdotgg/t3code`              | `updates.modelManifestUrl`, empty: bundled manifest only.                        |
| Desktop auto-update feed (`build-desktop-artifact.ts`)      | CI's `GITHUB_REPOSITORY`                                  | `updates.githubRepository` (or `T3CODE_DESKTOP_UPDATE_REPOSITORY`), empty: none. |
| Triage, About, boot error, star prompt, release links       | `pingdotgg/t3code`, `t3.codes`                            | `urls.*` (`ideanavigator/s7video`).                                              |

SSH environments, SSH device hosts and the WSL backend, whose scripts used `~/.t3` on the target,
are removed; see [Removed in S7V-018](#removed-in-s7v-018).

## Removed in S7V-018

s7video is a single-Mac editor, so connecting to other computers and code-hosting pull requests go.
Direct LAN pairing stays: this Mac can still be reached on the local network, and a client can
still pair with another server by link or code. The `REMOTE_ENVIRONMENTS_ENABLED` flag went with
the code it guarded.

| Area           | Removed                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages       | `packages/ssh`, `packages/tailscale`, `@t3tools/shared/remoteEnvironments`.                                                                                                                                                                                                                                                                                                       |
| Desktop        | `src/ssh/`, `src/wsl/`, SSH and WSL IPC, password prompts, the WSL primary and its preflight fallback, the Tailscale endpoint provider and Serve toggle, WSL folder picking. LAN address picking still skips 100.64.0.0/10.                                                                                                                                                       |
| Server         | SSH device hosts (`SshDeviceHost`, `sshDeviceScript`, `localSshDeviceHost`, `device.testHost`), Tailscale Serve at startup and its managed-policy cleanup, `--tailscale-serve*`, `t3 pair --tailscale`, Serve endpoint advertisement, Tailscale SSH open targets, the pull request sync and watch reactors, PR status in git status, and the Create PR step.                      |
| Web            | SSH and WSL environment UI, SSH device host editor, Tailscale HTTPS setup, "Create PR" and "Commit, push & PR" actions, and the pull request settings (auto-settle on merge, keep threads with a PR, merge method, agent credits, PR links, change request templates, review guides, PR sharing, PR keybindings). Tailscale wording and `ts.net` examples are gone from Settings. |
| client-runtime | SSH connection targets, profiles, registrations, gateway and broker; Create PR git actions.                                                                                                                                                                                                                                                                                       |
| contracts      | SSH/WSL desktop bridge methods and schemas, `runningDistro`, Tailscale Serve fields in the desktop exposure state and bootstrap, `SshDeviceHostConfig`, `deviceHosts`, `device.testHost`, the `create_pr` and `commit_push_pr` git actions.                                                                                                                                       |
| Scripts        | `dev --share`, `dev --built`, `scripts/lib/dev-share.ts`.                                                                                                                                                                                                                                                                                                                         |

### Old data

- Desktop settings with `tailscaleServe*`, `wslBackendEnabled`, `wslMode`, `wslDistro` or `wslOnly`
  load; the fields are ignored and dropped on the next save.
- Saved environments with `desktopSsh`, and catalog SSH targets, profiles and their credentials, are
  dropped on read.
- Server settings with `deviceHosts` decode; the list is ignored.
- `VcsStatusResult.pr` stays in the wire schema and is always null.

### Kept, with reasons

| Item                                                                                                                                                    | Why                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The pull request domain: inbox route, PR panel, review guides, PR RPCs, thread PR links and watches, PR MCP tools, PR routing grants, branch PR lookups | Deep in orchestration events, projections and the thread UI. Inert without a code host. Its removal is a separate ticket. Kept under the PO rule of 2026-11-05 (planning `tickets/README.md`, "Removing upstream code"). |
| Pull request entry points (sidebar button, "Open pull requests" palette action, branch toolbar PR badge)                                                | Hidden while no code host is registered (`apps/web/src/lib/codeHosts.ts`); they come back when one is.                                                                                                                   |
| PR MCP toolkit (about 12 tools, including `watch_pull_request`)                                                                                         | Still advertised to agents but inert: with no code host no PR URL resolves, and the watch reactor is gone.                                                                                                               |
| `pullRequest.copyNumber` default binding (`mod+shift+k`)                                                                                                | Inert outside the hidden PR panel; hidden from the keybindings editor.                                                                                                                                                   |
| "Delete merged worktrees" (`worktreeOnMerge`)                                                                                                           | Still shown so users can turn it off; it never matches a merged PR without a code host.                                                                                                                                  |
| WSL connecting splash, `devRemoteT3ServerEntryPath`, `isWslEnvironment` sidebar grouping parameter                                                      | Unused service members and fields; kept under the 2026-11-05 removal rule.                                                                                                                                               |
| Settings schema fields for removed PR options                                                                                                           | Kept so stored settings round-trip; the UI no longer shows them.                                                                                                                                                         |
| Generic "tailnet" route and interface classification, remote open over the host's own sshd (`mdns`)                                                     | Host classification and editor links, not the Tailscale package.                                                                                                                                                         |
| Desktop backend pool, `preflightFailure`, stdin bootstrap delivery                                                                                      | Generic backend machinery that WSL used; small upstream diff to keep.                                                                                                                                                    |
| Windows WSL runtime packaging in `build-desktop-artifact.ts`, `RemoteOpenTargetKind` `"tailscale"`                                                      | Windows packaging and a wire literal; out of scope for an Apple Silicon build.                                                                                                                                           |

## Usage data and diagnostics (S7V-013)

| Path                                                         | Decision                                                                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry/AnalyticsService.ts`                              | Off by default. Records only with a destination, no policy denial, and the `shareUsageData` setting or `S7VIDEO_TELEMETRY_ENABLED=true`.           |
| `policy/managedSettings.ts`                                  | Refuses `shareUsageData` in a policy's `settings`: only the user can opt in; `limits.telemetry: false` keeps it off.                               |
| Env vars                                                     | `S7VIDEO_TELEMETRY_{ENABLED,HOST,KEY,FLUSH_BATCH_SIZE,MAX_BUFFERED_EVENTS,CHANNEL}`. Upstream `T3CODE_TELEMETRY_*` and `T3CODE_POSTHOG_*` ignored. |
| Desktop shell forwarding                                     | Forwards `S7VIDEO_TELEMETRY_ENABLED` from the login shell instead of `T3CODE_TELEMETRY_ENABLED`.                                                   |
| Settings > Privacy (`apps/web`)                              | New page: privacy-policy link, and the sharing switch only when the server reports a destination.                                                  |
| OpenTelemetry export (`otelEnvironment.ts`, `http.ts` proxy) | Kept: exports only to an endpoint the user sets in Settings or the environment. Unset, nothing leaves the machine.                                 |
| Web client tracing (`clientTracing.ts`)                      | Kept: posts to the local server, which keeps traces for Diagnostics and forwards only to the user's own OTLP endpoint.                             |
| `isRelayTracingEnabled` (`otelEnvironment.ts`)               | Removed: relay tracing went with S7V-015 and nothing called it.                                                                                    |
| `pnpm brand:check`                                           | Also fails on upstream's ingest host or a PostHog project key in any tracked file, tests and allowed paths included.                               |

## Brand config (S7V-003)

- `s7video.config.ts` is the one place for name, ids, bundle id, URL scheme, data folder, CLI name,
  URLs, update endpoints, telemetry target, icon folder, theme files (`themes/*.json`) and credits.
  `packages/shared/src/config/` holds the schema (`brandConfig.ts`) and the active config (`brand.ts`).
- `S7VIDEO_CONFIG=<path>` selects another file at build time; `scripts/lib/brand-config.ts` points the
  bundlers at it and fails the build on an invalid config. Plain-Node runs (`pnpm dev:server`,
  scripts) use the default unless they load the config themselves. Example:
  `configs/example-whitelabel.config.ts`.
- `pnpm brand:check` fails on hard-coded `T3 Code`, `T3 Tools`, `t3.codes`, `pingdotgg/t3code`, a bare
  `t3code`, T3's accent colours, missing icons, empty URLs, unlicensed fonts and theme text below
  WCAG AA. Comments are not checked. Allowed and pending paths, each with a reason or owner, are listed
  in `scripts/brand-check.ts`.
- Kept on purpose for upstream merges: package names `@t3tools/*`, the server package `t3`, env vars
  other than `S7VIDEO_HOME`/`S7VIDEO_CONFIG`, `t3code:`/`t3code.` storage keys and trace attributes,
  `t3code/*` lint rule ids, the `t3.json` project file, the `"t3code"` message attribution in the event
  log, and recognisers for upstream `t3code/` branch and MCP tool names.
- Still T3's: the icon files in `assets/` (routed through `icons.directory`; replace with s7video art),
  the CLI's release-archive and npm names (`t3-<version>-<platform>`, `t3@<version>` for npm), and
  the GNOME extension's caller names, which are static and must be edited for a white-label build.

### User-visible effects

No sign-in screen. No account, Connect, guest link or "publish agent activity" options. Saved Connect-only machines disappear; direct and SSH machines stay. Websites in the in-app browser can no longer use passkeys.

## Community files and agent rules (S7V-006, S7V-008)

| Upstream                                                      | s7video                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`, `CONTRIBUTING.md` (T3's triage and model policy) | Rewritten for s7video: ticket-first, DCO, Conventional Commits, licence allowlist                                                                                                                                                                                                                                                                                                      |
| `.github/SECURITY.md` (security@ping.gg)                      | Root `SECURITY.md` with private advisories                                                                                                                                                                                                                                                                                                                                             |
| `bug_report.yml`, `pull_request_template.md`                  | `bug.yml`, `feature.yml`, `PULL_REQUEST_TEMPLATE.md`; `via-triage.yml` kept, reworded                                                                                                                                                                                                                                                                                                  |
| `TRIAGE_EXEMPTIONS.td`, `contribution-triage` skill           | Removed: they enforced T3's contribution triage                                                                                                                                                                                                                                                                                                                                        |
| `VOUCHED.td`                                                  | Kept empty: the preview workflow reads it, and T3's list must not get signed s7video previews                                                                                                                                                                                                                                                                                          |
| `AGENTS.md`                                                   | Rewritten. Kept: the three ways to hurt yourself, `vp` and dev-server notes, test rules, how the code works, hit every surface, taste (Effect patterns). Dropped: T3's product pillars, mobile and removed providers, relay and tunnel modes, GitCafe, seeding dev data from `~/.t3`. Added: read order, the per-ticket process, review and sign-off, data safety, gates, when to stop |
| `CLAUDE.md`                                                   | Pointer to `AGENTS.md` only                                                                                                                                                                                                                                                                                                                                                            |
| `.cursor/rules/cursor-cloud.mdc`                              | Kept for now: S7V-003 edits it, and deleting it here would conflict. Remove it after S7V-003 merges (T3's Cursor Cloud VM notes)                                                                                                                                                                                                                                                       |
| `test-t3-app` skill                                           | Renamed `test-app` and reworded; its dev commands pass `--no-seed --home-dir "$PWD/.t3"`                                                                                                                                                                                                                                                                                               |

New: `docs/engineering/` (standards), `docs/changelog/` (per-ticket entries), `docs/planning.md`,
`scripts/planning.ts` (`pnpm tickets`, `ticket:*`, `doc:new`) and `scripts/check-doc-links.ts`
(`pnpm docs:linkcheck`).

## Edit projects (S7V-024)

- **Every new named project is an edit project.** `ManagedProjectFolders.createNamedProject` adds `edit.json`, `project.json`, `styles/`, `assets/`, `.s7cache/` and `exports/`. It also adds a whitelist `.gitignore`, and commits those files with T3's starter `README.md` and `assets/icon.svg`. It only adds files: nothing of T3's scaffold is removed. Scratch projects and existing projects are not converted.
- **What is tracked.** The whitelist ignores everything except `edit.json`, `project.json`, `.gitignore`, `styles/`, `README.md` and `assets/icon.svg`. As a result, T3's per-turn checkpoints, turn diffs and turn reverts in an edit project only see those files. Media, cache, exports and anything else an agent writes outside them never show in a diff and are never reverted.
- **Edit undo is separate from turn reverts.** Edit undo (`edit.undo`) restores only `edit.json` (and bumps `project.json`) from refs under `refs/t3/edit/checkpoints/`. If a turn revert changes `edit.json`, the edit service records it as a new revision the next time the edit is read or changed.

## HEIC decoding (S7V-014)

T3 Code decodes iPhone HEIC photos with `heic-to`, which bundles libheif and libde265 under
LGPL-3.0-or-later. s7video removes it. The desktop app's `desktop:convert-heic` IPC method decodes
HEIC with macOS ImageIO (`/usr/bin/sips`), and the web app calls it through `convertHeic` on the
desktop bridge for attachments (`apps/web/src/lib/imageCompression.ts`) and previews
(`apps/web/src/components/files/decodeImagePreview.ts`). Electron's `nativeImage` cannot read HEIC.
In a plain browser, HEIC photos ask to be converted to JPEG first. When an upstream merge touches
HEIC code, keep `heic-to` out of every `package.json`.

## Local video helper (S7V-022)

s7video adds a Python helper that T3 Code does not have: `packages/engine`, a `uv` project, run by
`apps/server/src/engine/EngineService.ts` as one long-lived child process that speaks JSON-RPC over
stdio (ADR-004). It is new code, so upstream merges do not touch it; the upstream files it edits are
small additions to `config.ts` (`engineLogsDir`, `engineModelsDir`), `server.ts` (the layer),
`ws.ts`, the RPC contracts and their scope and metric maps (`engine.jobs.subscribe`,
`engine.jobs.cancel`). Development uses the developer's `uv` and FFmpeg (Homebrew's FFmpeg is GPL
and is never bundled); shipping a Python runtime and an LGPL FFmpeg is release work (S7V-016).
`pnpm licenses:check` also scans `packages/engine/uv.lock`.

## Video agent tools (S7V-023)

The `video` toolkit is new code in `apps/server/src/mcp/toolkits/video/` and
`apps/server/src/mcp/VideoProjectScope.ts`. These upstream files have small edits:

- `mcp/McpHttpServer.ts` adds `registerVideoFrame`, adds `layerVideoToolkit`, and adds it to `layerTools`.
- `mcp/McpInvocationContext.ts` adds the `video` capability and its `hiddenWithoutVideo` visibility check.
- `orchestration-v2/ProviderSessionManager.ts` grants `video` when the thread's project folder has `edit.json` and `project.json`.
- `orchestration-v2/Adapters/CodexAdapterV2.ts` and `provider/CodexProvider.ts` show a plain update message when Codex is below 0.159 in a video project.
- `provider/agentContextBudget.json` and `provider/AgentContextBudget.test.ts` have the new tool-list size and mocks.
- `orchestration-v2/runtimeLayer.ts` provides `ProjectService` around the whole production runtime.

**Behaviour change from `runtimeLayer.ts`.** The session manager reads `ProjectService` as an
optional service. Memoized layers keep the context of their first build, and resource cleanup built
the session manager first, without `ProjectService`. So upstream never found the thread's project
there. If any per-project browser or device access override existed, access fell back to
"withheld". Those overrides are now honoured.

`runtimeLayer.production.test.ts` guards the wiring. If upstream fixes the wiring itself, drop our line and
keep the test.

## Video edit instructions (S7V-041)

Threads with the `video` capability get one more instruction line: change, undo and redo the edit
only with the `video_` tools, never with git or a shell. A git restore of `edit.json` skips the
undo history. These upstream files have small, additive edits:

- `packages/provider-core/src/server/orchestrationInstructions.ts` adds
  `T3_CODE_VIDEO_EDIT_INSTRUCTIONS` and its `_WITH_TOOL_SEARCH` variant for Claude.
- `orchestration-v2/Adapters/ClaudeAdapterV2.ts` takes `videoToolsAvailable` and appends the line
  to the system prompt.
- `orchestration-v2/Adapters/CodexAdapterV2.ts` and `provider/CodexDeveloperInstructions.ts` add it
  to `t3_code_tools` through an optional `video` flag.
- `provider/AgentContextBudget.test.ts` and `agentContextBudget.json` measure the video-on context
  as `claudeSystemAppendVideoBytes` and `codexAdditionalContextVideoBytes`.

ACP agents and Claude's native subagents do not get the line yet.

## Licensing (S7V-004)

`LICENSE` is T3 Code's MIT licence with a second line, `Copyright (c) 2026 s7video contributors`.
`NOTICE` credits T3 Code, names OpenCut for when its code is used, and lists the Claude Agent SDK as
the one proprietary part (ADR-002).

**REUSE without touching upstream files.** `pnpm reuse:lint` passes for every tracked file, but no
T3 Code file gets an SPDX header. One catch-all `**` annotation in `REUSE.toml` gives every file
both holders (`2026 T3 Tools Inc.`, `2026 s7video contributors`) and MIT, the same statement as
`LICENSE`; adding headers to the ~4,600 upstream files would conflict with every upstream merge.
Who changed which line is in git history. Files s7video creates carry their own header, which wins
(`precedence = "closest"`). Later `REUSE.toml` entries name third-party code and media copied into
the repo: the opencode Office viewers, Ionic keyboard code, libghostty-vt, the Symbols Nerd Font
(3.4.0; MIT AND OFL-1.1 AND CC-BY-4.0 AND Apache-2.0 AND Unlicense, from its glyph sets), the CC0
sounds, the SPDX licence templates, the Linux `libatomic.LICENSE` (GPL-3.0-or-later WITH
GCC-exception-3.1) and the two Hyprland protocol XMLs (BSD-3-Clause). Changelog entries of finished tickets are frozen, so they are
covered there too rather than edited.

**`pnpm licenses:check`** (`scripts/licenses-check.ts`) reads `pnpm licenses list` for the whole
workspace and checks every installed package against `licenses.allowlist.json`. Production
packages must match the allowlist. Packages only build and test tools pull in are checked too; one
dev-only package, `truncate-utf8-bytes` (WTFPL, under electron-builder), is allowed by name (PO
decision, ADR-003 amendment). Dual licences take the permissive option (ADR-003): jszip under MIT,
dompurify under Apache-2.0; an election only picks among OR options. A patched MPL-2.0 package fails,
whether `patchedDependencies` names a version, a range or just the package. Missing metadata is
filled from `packageOverrides` in `third-party-licenses.config.json` (which also feeds the in-app
notices), but an override that disagrees with what a package declares fails rather than wins.
`licenses.exceptions.json` holds reviewed exceptions, each naming its ADR, a version range and the
`package.json` licence the review saw; today only `@anthropic-ai/claude-agent-sdk` (ADR-002,
`>=0.3.276 <0.4.0`). Rust crates under `native/` are not scanned here.

**What the check does not see.** It scans the repository's locked install. The desktop build
stages its own production `node_modules` with `vp install --prod` (`scripts/build-desktop-artifact.ts`),
resolved without the lockfile, so a transitive dependency could change between the scan and
`app.asar`. Scanning the staged install, or staging from the lockfile, is a follow-up for
S7V-009/S7V-011.

**Notices config.** S7V-004 dropped the `packageOverrides` for packages the strip tickets removed
(Expo and mobile tooling, `@electron-webauthn/*`, `objc-js`, the opencode SDK and others no longer
in `pnpm-lock.yaml`). It added custom notices for T3 Code and for Chromium inside Electron
(electron-builder already moves `LICENSES.chromium.html` into the app's `Contents/Resources`), and
shows the Claude Agent SDK as "Proprietary (Anthropic Commercial Terms)". The ticket asked to carry
`@pierre/diffs`' NOTICE, but `@pierre/diffs@1.6.1` ships no NOTICE file (only `LICENSE.md`); the
generator would pick one up automatically if a later version adds it.

## Merging upstream

Monthly, or when an upstream fix is needed:

```bash
git fetch upstream
git switch -c chore/upstream-merge-YYYY-MM main
git merge upstream/main
```

1. Removed paths show up as modify/delete conflicts. Resolve them by keeping them deleted:
   `git rm -r <path>` (for example `apps/mobile`, `packages/provider-cursor`).
2. Expect conflicts in the files this fork rewired: `apps/server/src/provider/builtInDrivers.ts`,
   `apps/server/src/server.ts`, `packages/client-runtime/src/providerClients.ts`, the two
   `*-definitions/src/registry.ts` files, `package.json`, `pnpm-workspace.yaml`, `knip.jsonc`,
   `vite.config.ts`, `third-party-licenses.config.json`, and the CI workflows.
3. Review every change under `packages/provider-*`, `packages/contracts` and
   `apps/server/src/provider` by hand: provider-layer and contract changes are where upstream
   behaviour reaches s7video. New upstream providers or hosts are not added unless a ticket asks.
4. Run `pnpm install` (the lockfile must update cleanly), then `pnpm typecheck`, `pnpm lint`,
   `pnpm knip:check`, `pnpm fmt:check` and `pnpm test`, and re-run
   `rg -n "provider-(cursor|fx|grok|muse|opencode|pi)|source-control-(github|gitlab|bitbucket|azure-devops|forgejo|gitcafe)|onepassword|@cursor/sdk|@muse-code/sdk" --hidden -g '!node_modules' -g '!pnpm-lock.yaml'`
   to catch re-introduced references.
5. Open a PR for the merge branch; it gets the same independent review as any card.

## Lockfile drift

Dropping the mobile catalog and overrides lets pnpm resolve react-native and Expo peers of kept web
dependencies (`@legendapp/list`, `morphicons`) on its own. That added 26 package versions the base
lock did not have (Expo config and modules, `noxcturnal` and its platform binaries, `xcode`). All are
MIT except `xcode` (Apache-2.0), so all are on the licence allowlist, and none is bundled at runtime.
The list is in the planning repo at `evidence/S7V-002/lockfile-delta.tsv`.
