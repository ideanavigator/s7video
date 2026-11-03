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

| Ticket                      | Scope                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| S7V-015                     | T3 cloud: Clerk, Connect, relay, `infra/relay` (and a decision on `packages/tailscale`). |
| S7V-013                     | Telemetry: turned off by default (kept in the code, not removed).                        |
| S7V-014                     | `heic-to` (LGPL).                                                                        |
| S7V-003 / S7V-004 / S7V-006 | Branding, licence notices, README.                                                       |

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
