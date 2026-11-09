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
- Ask the assistant for a reel (9:16), wide (16:9), square (1:1), 4:5 or 4:3 video and it changes
  the edit's shape in one step; undo takes it back, and the player and the export both follow it.
  (S7V-061)
- Pick "Remove silences" from the chat's / menu, or ask for it, and the assistant cuts the pauses and
  tells you how much it removed. It never does this unless you ask. (S7V-048)
- Ask the assistant to remove the silences and it cuts the pauses between your sentences without
  clipping words. It leaves in pauses with laughter or music, keeps any pause you ask for, and says
  how much it removed. Undo brings the previous edit back. (S7V-027)
- The Editor panel now shows a CapCut-style timeline with video, caption, sound effect, music and
  overlay rows. It follows playback, jumps where you click, and zooms around the pointer, and it
  stays smooth with a thousand cuts. (S7V-033)
- Clips on the timeline show their sound as a waveform and their picture as a strip of frames. They
  are prepared in the background right after import, even for long recordings. (S7V-035)
- One edit can now use several clips. The player plays straight across the joins, and the export
  matches. (S7V-039)
- Each change you or the assistant make becomes a numbered version in the Editor's Versions tab.
  Name any version, watch it in the player, or make it current again without losing anything after
  it. (S7V-069)
- When a project's history grows large, s7video asks whether to keep only recent versions or remove
  all old ones, says how much space that frees, and never touches your footage. (S7V-050)
- Drag, trim, split and delete clips on the timeline, with snapping to the playhead and other
  clips. Undo and redo cover your changes and the assistant's in one history. (S7V-034)
- Select words in the transcript and delete them to cut that part of the video, or restore
  struck-through words to bring them back. The timeline and player follow, and undo works.
  (S7V-038)
- "Add captions" now adds captions to the edit: a Captions row on the timeline and captions over
  the player, exactly as they will export. They follow your cuts, and one undo removes them.
  (S7V-075)

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
- Removing silences from a long recording answers at once: the clip's sound is measured once while
  its words are found, and reused every time you cut. (S7V-055)
- Undo works on any Mac: the edit's undo history is kept by s7video itself in the project, so undo
  and redo need no extra tools, and saving each step is faster. (S7V-051)
- No install prompts on a fresh Mac: s7video works without Apple's coding tools and never asks to
  install them. Coder features that need git appear only when git is installed, and new projects no
  longer record your name and computer name. (S7V-052)
- In a video project the assistant is offered only its video-editing tools, and none of the coding,
  pull-request, browser or device tools it inherited. Each reply sends about 95% less tool setup
  text. Other projects are unchanged. (S7V-072)
- Video projects open with the Editor beside the chat. Its first list shows your versions, newest
  marked Main, and you can make any older one main again. Drop a video anywhere on the Editor to
  add it. The Editor stays open after the assistant edits. (S7V-076)

### Removed

- Connecting to other computers over SSH, Tailscale or WSL; the "Create PR" action, pull-request
  status and sync; and the pull-request settings. The pull-request screens are hidden while no code
  host is set up. Local commit and push stay, and LAN pairing still works. (S7V-018)
- T3 Code's cloud features: Clerk sign-in, T3 Connect, the managed relay and tunnel, and guest share
  links. (S7V-015)
- Apps, agent providers and code-hosting integrations s7video does not use: the mobile app, the
  marketing site, the Cursor, Grok, OpenCode, Pi, Muse and fx providers, GitHub, GitLab, Bitbucket,
  Azure DevOps, Forgejo and GitCafe integrations, and the 1Password secret store. (S7V-002)

### Fixed

- For developers: a dev desktop app started from a linked git worktree keeps its own Electron
  profile in that worktree's dev home, so it no longer hands off to, or focuses, another
  checkout's app. The main checkout keeps its `s7video-dev` profile. (S7V-073)
- s7video no longer jumps in front of other apps by itself. It comes forward only when you click
  it, its Dock icon or a notification. (S7V-074)
- Asking to keep a pause that was already cut now gets a plain answer and a hint to undo, and a
  short pause you keep stays short (about a third of a second). (S7V-056)
- In the browser, the greyed-out Add media button and the empty Assets list and player now explain
  what to do instead: drop files into the chat, or use the desktop app for large files. (S7V-065)
- When an undo or redo makes no visible difference, such as going back past adding a clip (which
  stays in Assets), the assistant says so and tells you whether there is more to undo, instead of
  saying "Undone". (S7V-063)
- A large 4K clip now shows in Assets with its name, length and size in under two seconds; its
  preview picture follows a moment later. (S7V-064)
- The assistant makes a video only when you ask for one, and a video keeps the shape it was filmed
  in: a wide clip exports wide unless you ask for another shape. (S7V-061)
- A clip dropped into the chat that can't be added to Assets now says why, with Retry, instead of
  being attached to the message silently; a sound that can't be added stays attached, and the
  message says so. The video helper no longer writes Python bytecode into the app's folders.
  (S7V-071)
- The speech model can be downloaded from first-run setup, Settings → Providers or a prompt at the
  top of the Editor panel, which opens by itself when the assistant needs the model; before, only
  the Transcript tab asked. A copy already in a Hugging Face cache on your Mac can be used instead
  of downloading. (S7V-067)
- A chat in plan mode can look at your video but no longer imports, transcribes, cuts, exports,
  undoes or redoes, and a device allowed to edit can no longer add a file from elsewhere on your Mac
  to a project to play or download it. (S7V-066)
- No visible change: the Editor panel's video-retry tests no longer fail on a busy machine. (S7V-060)
- Chats open again with the default settings: the Git actions row no longer crashes the page looking
  for a code-hosting site to publish to, and shows no publish option while none is set up. (S7V-057)
- Undo and redo no longer take an imported clip out of Assets. Clips attached in chat keep their
  original file name, and Assets lengths read as minutes and seconds (2:19, not 2:19:20). (S7V-059)
- A second, tighter silence cut no longer fails with a duplicate id, and the agent waits for a
  first transcription to finish instead of stopping halfway, and says so if it failed or was
  stopped. (S7V-058)

### Security

- No visible change: reusing a speech model from another app's download folder now accepts only
  files inside that model's own folder, never a file a stray link points to. (S7V-068)
- If an assistant changes your edit without the app's video tools, the change is kept only if it
  is valid and adds no file from outside your project; otherwise your edit goes back to its last
  saved version and you see why. (S7V-054)

[Unreleased]: https://github.com/ideanavigator/s7video/commits/main
