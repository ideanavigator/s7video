<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Privacy

s7video is a local-first Mac app. Your projects, footage, transcripts and edits stay on your
computer. **The s7video project collects nothing by default**: no analytics, no crash reports, no
account. Anything that leaves your computer goes to a service you chose, for the work you asked for.

This page covers the app as built from this repository. Builds published by someone else may behave
differently; check their policy.

## What stays on your computer

- Your raw footage. Originals are never modified and never uploaded by s7video.
- Proxies, thumbnails, waveforms, transcripts, edit documents, notes, versions, review comments and
  renders, in your project folder.
- Chats with the agent, settings and app state, in the s7video data folder (`~/.s7video`).
- The built-in video helper, which reads clips and grabs frames, runs on your Mac as a separate
  program and sends nothing anywhere. It works offline; its log (`logs/engine/` in the data folder)
  records what it did and how long it took, never your footage, transcripts or messages.
- Secrets you save in settings, in the data folder. API keys for the planned bring-your-own-key
  mode will be kept in the macOS Keychain. Keys are never written to logs or project files.

To delete everything, quit the app, delete your project folders and `~/.s7video`.

## What leaves your computer, by mode

You pick how the agent runs. The table says what each mode sends and where.

| Mode                         | Available | What is sent                                                                                                                                                                                                               | Sent to                                                                                                                                 |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Your installed CLI agent** | Now       | Your messages and whatever the agent reads to answer them: files in the project you opened, command output, and screenshots or attachments you add. The agent CLI decides what to read within the permission mode you set. | The provider you signed in to with that CLI (for example Anthropic for Claude Code, OpenAI for Codex), under your account and its terms |
| **Local**                    | Planned   | Nothing. Transcription and the language model run on your Mac.                                                                                                                                                             | Nobody                                                                                                                                  |
| **Bring your own key**       | Planned   | Transcripts, the edit plan, your messages and a few sampled low-resolution frames. Never the raw video or audio files.                                                                                                     | The provider whose key you entered (for example Anthropic, OpenAI, OpenRouter or Google), under your key and its terms                  |
| **s7video Cloud (Pro)**      | Planned   | The same as bring your own key: transcripts, the edit plan, your messages and a few sampled low-resolution frames, never the raw files.                                                                                    | The s7video proxy, which forwards them to the model provider                                                                            |

In a video project the agent can also ask s7video for a clip's details (length, size, codecs), a
summary of the current edit and single frames as small pictures (640 pixels wide unless it asks for
another size). These go to the same provider as the rest of the chat, only when the agent asks, and
only for files in that project.

In the planned modes, s7video itself decides what is sent, and the rule is the one above: text and a
few small frames, never the original media. In the installed-CLI mode the agent works like it does in
your terminal, so anything in the opened project can be read by it and sent to its provider. Open only
folders you are happy for that provider to see.

s7video Cloud does not exist yet. Before it launches this page will say how long the proxy keeps
requests, and how to export or delete your Cloud data.

## Other connections the app makes

These carry no project content:

- **Update checks:** off until s7video publishes releases; then the app and its local server check
  the project's GitHub releases for new versions (the update feed is set in the brand config).
- **Model and agent lists:** the app downloads the public list of installable agents (the Agent
  Client Protocol registry). The model list download is off until s7video publishes its own.
- **Agent installs and sign-in:** when you install or sign in to an agent from the app, it talks to
  that agent's maker (for example Google for Antigravity, OpenAI for Codex).
- **Pages you open:** the built-in browser and previews load the pages you ask for.

## Usage data

Sharing pseudonymous usage data is **off by default** and is never switched on for you. Nothing is
collected until you turn it on.

- The open-source build has no usage-data destination configured, so it cannot send usage data at
  all, and **Settings > Privacy** shows no switch.
- If a build offers it, you turn it on under **Settings > Privacy > Share pseudonymous usage data**, or
  with `S7VIDEO_TELEMETRY_ENABLED=true` in the app's environment. It would send pseudonymous product
  events such as which agent, model, app features and agent tools were used, permission mode, how turns ended, how long they took, token
  counts and the app version. Events are tied to a random installation ID and to one-way hashes of
  the agent accounts you are signed in to (OpenAI, Claude) and of each connecting device, so that one
  person's installations are counted once.
- Usage data never includes your prompts, the agent's replies, file contents, footage, transcripts,
  file paths, API keys or sign-in tokens.
- An administrator's [managed policy](docs/user/managed-policy.md) can keep it off; it cannot turn it
  on. Details: [Product usage data](docs/user/telemetry.md).

s7video never sends usage data to T3 Code's servers or to anyone other than the destination named in
the build's settings.

Diagnostics export (OpenTelemetry) sends traces, metrics or logs only to a receiver you configure
yourself.

## Changes and contact

Changes to this policy are listed in [CHANGELOG.md](CHANGELOG.md). Questions:
[shashwatusa7@gmail.com](mailto:shashwatusa7@gmail.com).
