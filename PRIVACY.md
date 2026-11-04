<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Privacy

s7video is a local-first Mac app. Your projects, footage, transcripts and edits stay on your
computer. **The s7video project collects nothing by default**: no analytics, no crash reports, no
account. Anything that leaves your computer goes to a service you chose, for the work you asked for.

> [!WARNING]
> **Current pre-alpha build (2026-11-04).** Until the Sprint 01 privacy work lands, a build from
> `main` still behaves like T3 Code in these ways:
>
> - **Usage data is on by default** and goes to T3 Code's analytics service (`ingest.t3.codes`).
>   Removed by S7V-013. To turn it off now, set `T3CODE_TELEMETRY_ENABLED=false` before starting the
>   app.
> - **Data is stored in `~/.t3`**, the same folder as an installed T3 Code, not `~/.s7video`.
>   Fixed by S7V-003.
> - **Update and model-list checks go to T3 Code's GitHub and npm** (`pingdotgg/t3code`, the `t3`
>   package). Removed by S7V-003.
>
> The rest of this page describes s7video from the end of Sprint 01. This box is removed when
> S7V-013 lands.

This page covers the app as built from this repository. Builds published by someone else may behave
differently; check their policy.

## What stays on your computer

- Your raw footage. Originals are never modified and never uploaded by s7video.
- Proxies, thumbnails, waveforms, transcripts, edit documents, notes, versions, review comments and
  renders, in your project folder.
- Chats with the agent, settings and app state, in the s7video data folder (`~/.s7video`).
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

Sharing anonymous usage data is **off by default** and is never switched on for you.

- The open-source build has no usage-data destination configured, so it cannot send usage data even
  if the setting is switched on, and the switch is hidden.
- If an official build offers it, you turn it on under **Settings > Privacy > Share anonymous usage
  data**. It would send product events such as which agent and model were used, permission mode, how
  turns ended, how long they took, token counts and the app version, tied to a random installation
  ID.
- Usage data never includes your prompts, the agent's replies, file contents, footage, transcripts,
  file paths, API keys or sign-in tokens.

s7video never sends usage data to T3 Code's servers or to anyone other than the destination named in
the build's settings.

Diagnostics export (OpenTelemetry) sends traces, metrics or logs only to a receiver you configure
yourself.

## Changes and contact

Changes to this policy are listed in [CHANGELOG.md](CHANGELOG.md). Questions:
[shashwatusa7@gmail.com](mailto:shashwatusa7@gmail.com).
