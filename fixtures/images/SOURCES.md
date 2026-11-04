<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Image fixtures

Every file here is synthetic: a coloured test pattern drawn by [generate.swift](generate.swift) and
encoded with macOS ImageIO. None of them is a photo, and none contains people or client media.

| File                     | What it is                                                       | Source | Licence |
| ------------------------ | ---------------------------------------------------------------- | ------ | ------- |
| `landscape.heic`         | 192x128 HEIC, EXIF orientation 1                                 | ours   | MIT     |
| `portrait.heic`          | The same pixels with EXIF orientation 6 (shown 128x192, rotated) | ours   | MIT     |
| `landscape.expected.png` | How `landscape.heic` must look once decoded                      | ours   | MIT     |
| `portrait.expected.png`  | How `portrait.heic` must look once decoded: upright, 128x192     | ours   | MIT     |

The `heic-to-jpeg` golden test (`pnpm test:golden -- heic-to-jpeg`) decodes each HEIC through the
desktop app's converter and compares it with its `.expected.png`. Regenerate all four with
`swift fixtures/images/generate.swift fixtures/images` and say why in the pull request.
