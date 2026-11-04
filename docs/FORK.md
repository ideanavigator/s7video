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
| `packages/ssh`                                                                                                                                                                                                                          | Deeply coupled: desktop SSH environments (IPC, password prompts, web sidebar and settings), server SSH device hosts, and the WSL environment (`buildRemoteNodeEnvScript`). Removing it means redesigning remote environments.                                                            |
| `packages/tailscale`                                                                                                                                                                                                                    | Coupled to direct-endpoint advertisement, `t3 pair`, remote open targets, managed limits, desktop server exposure, `dev --share`, and `cloud/ConnectReachability.ts`. The cloud side belongs to S7V-015; revisit both together.                                                          |
| `packages/source-control-core`, `source-control-definitions`                                                                                                                                                                            | Local git, checkpoints, PR-link parsing and settings types import them.                                                                                                                                                                                                                  |
| `packages/source-control-testing`                                                                                                                                                                                                       | Imported by 3 kept server test files (`PullRequestService`, `SourceControlProviderRegistry`, `SourceControlDiscovery`; about 100 cases).                                                                                                                                                 |
| `native/resource-monitor`                                                                                                                                                                                                               | The server's resource telemetry runs it on macOS.                                                                                                                                                                                                                                        |
| `native/hyprland-snap-shot`, `native/kde-snap-shot`, `apps/desktop/gnome-extension`, `dist:gnome-extension`                                                                                                                             | Linux snap-shot capture; wired into desktop snap-shot code, contracts IPC and web settings. Not self-contained.                                                                                                                                                                          |
| Exports in kept packages that only removed code used                                                                                                                                                                                    | Listed under `ignoreIssues` in `knip.jsonc`. Deleting them would turn every upstream change to those files into a conflict. Prune them only together with upstream. Since 2026-11-03 those files are not checked for new dead exports; S7V-009 replaces this with a per-symbol baseline. |
| Inert code keyed on removed provider names (`"cursor"`, `"grok"`, `"opencode"`, `"pi"`, `"muse"`, `"fx"`), e.g. provider status caching, model manifest entries, usage provider lists and the Cursor Keychain section of the Usage page | No driver reports these kinds, so the branches never run. Kept on purpose so upstream merges apply cleanly.                                                                                                                                                                              |
| Mobile-only lint rules in `oxlint-plugin-t3code`                                                                                                                                                                                        | Inert without `apps/mobile`; they carry their own tests.                                                                                                                                                                                                                                 |
| `@clerk/*` (except the mobile-only `@clerk/expo` catalog entry), `infra/*`, telemetry, `heic-to`                                                                                                                                        | Out of scope here; see below.                                                                                                                                                                                                                                                            |

## Changed later

| Ticket            | Scope                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| S7V-015           | Done: T3 cloud removed (see below). `packages/tailscale` and `packages/ssh` stay until S7V-018. |
| S7V-013           | Telemetry: turned off by default (kept in the code, not removed).                               |
| S7V-014           | `heic-to` (LGPL).                                                                               |
| S7V-003           | Done: branding from `s7video.config.ts`, own data folder, no T3 endpoints (see below).          |
| S7V-004           | Licence notices.                                                                                |
| S7V-006 / S7V-008 | Done: community files and agent rules (see below).                                              |

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
| `telemetry/AnalyticsService.ts`                             | PostHog at `ingest.t3.codes`                              | `telemetry.host`/`key`, empty: sends nothing. The default switch is S7V-013's.   |
| `cloud/npmRelease.ts`, polled by clients every 5 minutes    | npm package `t3`                                          | `updates.npmPackage`, empty: no lookup, reports no release.                      |
| `cloud/pinnedRuntime.ts`, `selfUpdate.ts`, `bootService.ts` | `t3` binaries from `github.com/pingdotgg/t3code/releases` | `updates.githubRepository`, empty: install fails before any download.            |
| `cloud/servicePreflight.ts`                                 | `curl https://t3.codes/install.sh`                        | `updates.installScriptUrl`, empty: names `urls.repository` instead.              |
| `cli/update.ts`                                             | `api.github.com/repos/pingdotgg/t3code`                   | `updates.githubRepository`, empty: fails with "has no release feed".             |
| `provider/ModelManifest.ts` (hourly)                        | `raw.githubusercontent.com/pingdotgg/t3code`              | `updates.modelManifestUrl`, empty: bundled manifest only.                        |
| Desktop auto-update feed (`build-desktop-artifact.ts`)      | CI's `GITHUB_REPOSITORY`                                  | `updates.githubRepository` (or `T3CODE_DESKTOP_UPDATE_REPOSITORY`), empty: none. |
| Triage, About, boot error, star prompt, release links       | `pingdotgg/t3code`, `t3.codes`                            | `urls.*` (`ideanavigator/s7video`).                                              |

SSH environments, SSH device hosts and the WSL backend are turned off (`REMOTE_ENVIRONMENTS_ENABLED`
in `@t3tools/shared/remoteEnvironments`). Their scripts still use `~/.t3` on the target, which on
this Mac or any host with T3 Code would reach T3 Code's data and server. S7V-018 removes them.

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
