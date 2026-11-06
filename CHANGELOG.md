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
- MIT licence naming T3 Tools Inc. and the s7video contributors, a `NOTICE` file, REUSE-compliant
  copyright information for every file (`pnpm reuse:lint`), `pnpm licenses:check` against the
  licence allowlist, and T3 Code and Chromium in the in-app open-source licences list. (S7V-004)
- A free-licence (CC-BY-4.0) sample video that `pnpm media:fetch` downloads with a checksum into a
  cache outside the repo, a guard that fails `pnpm licenses:check` if media or model weights are
  committed, and engine golden tests in `pnpm test:golden`. (S7V-031)
- A built-in video helper that reads clips and grabs frames on your Mac. It starts on demand,
  restarts itself if it stops, and names any missing tool on a developer machine. (S7V-022)
- Each new project keeps one edit record (`edit.json`) shared by the assistant and the editor;
  every change can be undone and redone, and undo never touches your footage. (S7V-024)
- The assistant can see your video: Claude, Codex and other agents can read a clip's details, look
  at any frame and read the current edit, for files in your project only. Codex older than 0.159
  gets a plain message asking to update it. (S7V-023)
- Export your edit as an MP4 with captions burned in, at −14 LUFS, using your Mac's video hardware.
  It runs with progress and cancel, and lands in the project's `exports/` folder. (S7V-028)
- Transcription on your Mac, word by word with frame-accurate timings. s7video asks once before
  downloading the speech model (about 3.7 GB, or 2.3 GB for the light model), then works offline,
  and each clip is transcribed only once. Models are listed in `MODELS.md`. (S7V-026)
- Bring in footage of any size: drop or pick clips into a project, keep a copy (instant on the same
  drive) or point at the original, and see them in the new Assets tab with length, size and a
  thumbnail. Awkward files get a smooth preview copy in the background, and a moved original can be
  relinked. Video dropped into a video project's chat is imported instead of uploaded. (S7V-025)
- An Editor panel beside the chat plays your edit as it stands, skipping the parts that were cut,
  with tabs for the transcript and your project's clips and an Export button. Every chat in a project
  shows the same edit, and the Editor opens by itself when a project gets its first clip. (S7V-029)
- The Transcript tab shows every word, highlights the one being spoken, jumps the player when you
  click a word, and crosses out words the edit removed. (S7V-030)
- Exports now show captions made from your transcript, timed to your voice, with cut words left
  out. Without a transcript, the Export button asks you to transcribe the clip first, or offers to
  export without captions. (S7V-046)
- Undo from chat: say "undo that" or "redo" and the assistant steps your edit back or forward. Your
  footage is never touched. (S7V-041)

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

- Connecting to other computers over SSH, Tailscale or WSL; the "Create PR" action, pull-request
  status and sync; and the pull-request settings. The pull-request screens are hidden while no code
  host is set up. Local commit and push stay, and LAN pairing still works. (S7V-018)
- T3 Code's cloud features: Clerk sign-in, T3 Connect, the managed relay and tunnel, and guest share
  links. (S7V-015)
- Apps, agent providers and code-hosting integrations s7video does not use: the mobile app, the
  marketing site, the Cursor, Grok, OpenCode, Pi, Muse and fx providers, GitHub, GitLab, Bitbucket,
  Azure DevOps, Forgejo and GitCafe integrations, and the 1Password secret store. (S7V-002)

[Unreleased]: https://github.com/ideanavigator/s7video/commits/main
