<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Theming and configuration

**Rule:** no product name, colour, URL, bundle ID, protocol, icon path or data folder is hard-coded in
app code. They all come from one typed brand config and its theme files, so a fork or a white-label
build changes one place.

## Where values live

Keys as defined in S7V-003's `s7video.config.ts`:

| Value                                                                                    | Key                                                                                        | s7video default                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| App ID, product name (window title, menu bar)                                            | `app.id`, `app.productName`                                                                | `s7video`                                                  |
| Bundle ID                                                                                | `app.bundleId`                                                                             | `app.s7video.desktop`                                      |
| URL scheme for deep links                                                                | `app.protocol`                                                                             | `s7video` (`s7video://...`)                                |
| Data folder, under the user's home                                                       | `app.homeDir`                                                                              | `.s7video` (that is, `~/.s7video`)                         |
| CLI name, publisher                                                                      | `app.cliName`, `app.publisher`                                                             | `s7video`, `s7video contributors`                          |
| Homepage, repository, issues, docs, privacy policy                                       | `urls.*`                                                                                   | `https://github.com/ideanavigator/s7video` and pages in it |
| Update and install sources: GitHub releases, npm package, install script, model manifest | `updates.*`                                                                                | empty: every one is off until s7video publishes it         |
| Telemetry destination                                                                    | `telemetry.host`, `telemetry.key`                                                          | empty: no destination, so nothing can be sent              |
| Icons                                                                                    | `icons.directory`                                                                          | `assets`                                                   |
| Colours, fonts, radius                                                                   | `theme.light`, `theme.dark` (from `themes/s7video-light.json`, `themes/s7video-dark.json`) | light and dark themes                                      |
| Upstream credit                                                                          | `credits.*`                                                                                | T3 Code, MIT                                               |
| Which config file                                                                        | `S7VIDEO_CONFIG` environment variable                                                      | `s7video.config.ts`                                        |

The config arrives with S7V-003, which also replaces the T3 Code values still in the code (for example
`apps/web/src/branding.ts`). Until it lands, do not add new brand strings anywhere; reuse the existing
branding module. Later settings (default models, styles, feature flags) get keys in the ticket that
adds them.

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
- New environment variables use the `S7VIDEO_` prefix. Upstream `T3CODE_*` names (for example
  `T3CODE_DEV_SEED`, `T3CODE_TELEMETRY_ENABLED`) keep working until the ticket that renames each one.
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
