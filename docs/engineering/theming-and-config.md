<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Theming and configuration

**Rule:** no product name, colour, URL, bundle ID, protocol, icon path or data folder is hard-coded in
app code. They all come from one typed brand config and its theme files, so a fork or a white-label
build changes one place.

## Where values live

| Value                                                         | Source                                                  | s7video default                                         |
| ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| App name, window title, menu bar name                         | `s7video.config.ts` → `app.name`                        | `s7video`                                               |
| Bundle ID                                                     | `app.bundleId`                                          | `app.s7video.desktop`                                   |
| URL scheme for deep links                                     | `app.protocol`                                          | `s7video` (`s7video://project/...`)                     |
| Icons                                                         | `app.icons`                                             | `branding/s7video/icons`                                |
| Data folder                                                   | `app.homeDir`                                           | `~/.s7video` (development: `~/.s7video/dev`)            |
| Project site, docs, privacy, terms                            | `app.urls`                                              | `https://github.com/ideanavigator/s7video` and its docs |
| Update feed and channel                                       | `updates`                                               | the project's GitHub releases, `stable`                 |
| Default provider, models, style, aspect, frame rate, loudness | `defaults`                                              | see the config file                                     |
| Feature flags (telemetry, cloud, share links)                 | `features`                                              | telemetry off                                           |
| Colours, fonts, radius                                        | `themes/s7video-dark.json`, `themes/s7video-light.json` | dark and light themes                                   |
| Environment variables                                         | `S7VIDEO_*` prefix                                      | `S7VIDEO_TELEMETRY_ENABLED`, `S7VIDEO_CONFIG`, ...      |

The config file, its schema and the theme files arrive with S7V-003, which also replaces the T3 Code
values still in the code (for example `apps/web/src/branding.ts`). Until it lands, do not add new
brand strings anywhere; reuse the existing branding module.

## Rules for code

- Read names, URLs and paths from the config module. Never write `"s7video"`, `"T3 Code"`, a GitHub
  URL or `~/.s7video` as a literal in app code. Tests may use literals for the default config.
- Colours come from theme tokens through CSS variables. No hex, `rgb()` or Tailwind palette colours
  (`bg-blue-500`) in components; add a token instead.
- `apps/web/src/components/ui` components own their look: pick a `variant` or `size`, do not restyle
  them with `className` (enforced by `shadcn/no-restyle`). See [Web UI](../internals/web-ui.md).
- Every token is defined in both themes. Text on any panel meets WCAG 2.2 AA contrast in both.
- Track and diff colours (video, text, sound effects, music; added and removed) are tokens too, so
  timelines and edit diffs follow the theme.
- Fonts referenced by a theme are bundled with their licence file, or are system fonts.
- Environment variables use the `S7VIDEO_` prefix. Upstream `T3CODE_*` names are not read.
- Feature flags are read from config at runtime; no `if (brand === ...)` checks.

## Checking

`pnpm brand:check` (S7V-003) fails the build on a missing icon size, an empty URL, a bundled font
without a licence, a theme below AA contrast, or `T3 Code` / `t3code` / `T3 Tools` outside the allowed
places (licences, NOTICE, `docs/FORK.md`, the credits screen and upstream-tracking code). Reviewers
also check new code by eye, since a check cannot catch every hard-coded colour.

## White-label builds

A different brand is a different config file:

```bash
S7VIDEO_CONFIG=configs/example-whitelabel.config.ts pnpm dev:desktop
```

Forks that ship must change the name, icons, bundle ID and protocol; see
[TRADEMARK.md](../../TRADEMARK.md).
