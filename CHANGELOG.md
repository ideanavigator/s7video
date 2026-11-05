<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Changelog

All notable changes to s7video are listed here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Each entry names the ticket it came
from; the per-ticket entries and how this file is compiled are in
[docs/changelog](docs/changelog/README.md).

## [Unreleased]

### Added

- Community and governance files: README, contributing guide with DCO sign-off, Code of Conduct,
  security, governance, trademark, support and privacy policies, issue and pull request templates,
  and code owners. (S7V-006)
- Written rules for agents and contributors (`AGENTS.md`), engineering standards in
  `docs/engineering/`, this per-ticket changelog, and `pnpm tickets` / `ticket:*` commands that run
  the planning repo's ticket tools. (S7V-008)

### Changed

- The app is called s7video and keeps its data in `~/.s7video`; name, theme, links and endpoints come
  from `s7video.config.ts`, so it installs alongside T3 Code without touching its data. (S7V-003)
- Usage data is off by default and sent only if you turn it on in the new Settings > Privacy page
  (or with `S7VIDEO_TELEMETRY_ENABLED=true`). The open-source build has no destination and offers no
  switch; upstream's `T3CODE_TELEMETRY_*` variables are ignored. (S7V-013)
- HEIC and HEIF photos are decoded by macOS in the desktop app instead of the bundled LGPL `heic-to`
  library; rotated iPhone photos show the right way up, and a plain browser asks you to convert HEIC
  to JPEG first. (S7V-014)
- No visible change: three automated checks lost while removing unused agents are restored (agent
  wake-ups, the Push and Create PR buttons after a commit, usage stats with one broken agent config).
  (S7V-017)

### Removed

- Connecting to other computers over SSH, Tailscale or WSL, and the pull-request screens: "Create
  PR", pull-request status and sync, and their settings. Local commit and push stay, and LAN pairing
  still works. (S7V-018)
- T3 Code's cloud features: Clerk sign-in, T3 Connect, the managed relay and tunnel, and guest share
  links. (S7V-015)
- Apps, agent providers and code-hosting integrations s7video does not use: the mobile app, the
  marketing site, the Cursor, Grok, OpenCode, Pi, Muse and fx providers, GitHub, GitLab, Bitbucket,
  Azure DevOps, Forgejo and GitCafe integrations, and the 1Password secret store. (S7V-002)

[Unreleased]: https://github.com/ideanavigator/s7video/commits/main
