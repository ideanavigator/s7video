# s7video docs

The user guides below come from T3 Code and still use its name in places.

## Using the app

- [Install T3 Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Use T3 Code as your default browser](./user/default-browser.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Running in the background](./user/background-service.md)
- [Updating T3 Code](./user/updating.md)
- [Triage an issue](./user/triage.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [Antigravity](./user/providers-antigravity.md) · [ACP agents](./user/providers-acp.md)

---

## Working on s7video

Start with the [development runbook](./operations/development.md), the
[contribution guide](../CONTRIBUTING.md), the [agent rules](../AGENTS.md) and the
[engineering standards](./engineering/README.md). How work is planned: [planning.md](./planning.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Adding a provider](./internals/adding-a-provider.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)
- [Media import](./internals/media-import.md)
- [Edit history](./internals/edit-history.md)
- [Timeline](./internals/timeline.md)
- [Captions in the edit](./internals/captions.md)
- [Sound effects, music and loudness](./internals/audio-mix.md)
- [Punch-in zoom](./internals/punch-in-zoom.md)
- [Export for editors (OTIO, FCPXML, FCP7 XML, EDL)](./internals/pro-export.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
