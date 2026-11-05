<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Testing

Which tests a ticket needs, where they live and how to run them. The rules for writing a good test
(what to test, never sleeping or polling, browser-test patterns) are in
[docs/internals/testing.md](../internals/testing.md) and apply to every tier here.

## Tiers

Every ticket's Test Plan lists each tier, with `N/A - reason` where one genuinely does not apply.

| Tier            | What                                                                                                                                                                                                              | Tool and location                                                                                                                                                            | Run with                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1. Unit         | Pure logic: parsing, reducers, schema decoding, edit-document operations                                                                                                                                          | Vitest via Vite+ (`*.test.ts` next to the code); pytest for the engine once it exists                                                                                        | `vp test run <files>`           |
| 2. Edge cases   | The failure paths the ticket names: empty, huge, odd frame rates, variable frame rate, silent or missing audio, offline, missing model, bad or revoked key, cancel mid-way, disk full, old documents and settings | Same files as Tier 1, in their own `describe`                                                                                                                                | `vp test run <files>`           |
| 3. End to end   | A full user flow in the desktop app                                                                                                                                                                               | Playwright driving Electron (`playwright-core`, already a desktop dependency). The `e2e/` harness is built by the first ticket that needs it, as part of that ticket's scope | `pnpm e2e -- <spec>` once added |
| 4. Golden media | A fixed input clip through the real pipeline, compared with a stored reference                                                                                                                                    | `pnpm test:golden`, built by the first ticket marked `Touches media: yes`, as part of its scope                                                                              | `pnpm test:golden -- <case>`    |
| UX screenshots  | Every changed screen in dark and light themes at `1440x900` and the minimum `1180x760`                                                                                                                            | Playwright, attached to the PR (not committed)                                                                                                                               | per ticket                      |

The planning repo's `tickets/test-map.json` maps each ticket to its commands per tier;
`pnpm ticket:verify -- S7V-XXX` runs them in order: setup, unit, edge, golden, e2e, ux, smoke.
Keep the map and the ticket's Verification Commands in sync.

## Golden media tests

Required for every ticket with `Touches media: yes`. Each case is a short input clip, the operation
(cut list, captions, style, render settings) and a stored reference output. A case passes when:

| Check                        | Tolerance                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Cut list (in and out points) | Exact, in frames at the project frame rate                                            |
| Frame count and duration     | Exact frame count; duration within one frame                                          |
| Picture                      | SSIM ≥ 0.98 on sampled frames, and a perceptual-hash distance ≤ 6 per frame           |
| A/V sync                     | As in [media-standards.md](media-standards.md#audio-and-video-sync)                   |
| Loudness                     | Integrated loudness within ±0.5 LU of the reference; true peak at or under the target |
| Captions                     | Word timings within one frame of the reference; every caption inside the safe zone    |
| Colour tags                  | Primaries, transfer, matrix and range equal to the reference                          |

A ticket may tighten these; loosening one needs the PO's agreement in the ticket. When a reference
legitimately changes, the PR regenerates it, says why, and attaches before and after frames.

## Test media

- Only clips we shot ourselves, or clips released as CC0-1.0 or CC-BY-4.0 (with attribution), each
  listed with its source, author and licence in the fixture folder's `SOURCES.md`. This matches the
  licence allowlist; CC-BY-3.0, CC-BY-SA and site licences (Pexels, Pixabay) do not qualify.
- **Never client footage or audio** (from any client), CapCut
  library sounds or effects, or anyone else's media without one of those licences, even for a quick
  local test that "won't be committed".
- **Audio and video are never committed.** Each clip is listed in
  [fixtures/media/manifest.json](../../fixtures/media/manifest.json) and downloaded by
  `pnpm media:fetch` into a cache outside the repo (`$S7VIDEO_TEST_MEDIA_DIR`, default
  `~/Library/Caches/s7video-test-media`), checked against its sha256 and size. Synthetic clips come
  from [fixtures/media/synth.ts](../../fixtures/media/synth.ts) into the same cache.
  `pnpm licenses:check` fails if any audio, video or model-weights file is tracked.
- Keep fixtures small: a few seconds, low resolution unless the test is about resolution.
- Model weights are never fixtures. Tests that need a model use a stub, or skip with a clear reason
  when the model is not downloaded.

### Engine golden tests

Python goldens live in `packages/engine/tests/golden/` as `<case_name>_golden.py`;
`pnpm test:golden -- <case-name>` runs one (kebab case maps to the snake-case file). They use
`harness.py` there (probe summary, SSIM, perceptual hash, loudness, cut-list and word-timing
comparison) and its `media("<clip-id>")` fixture, which skips with "run pnpm media:fetch" when the clip
is not in the cache. `pnpm test:golden` fetches or reuses the clips first (`--no-fetch` skips that).

## Providers and cost

Real agent turns cost money. Use the free `Replay (dev)` provider that `vp run dev` registers to stream
recorded turns through the pipeline and UI; see the
[test-app skill](../../.agents/skills/test-app/SKILL.md). Use a real provider only when the
change depends on its behaviour, with its cheapest model.

## Running tests locally

There is no CI until Sprint 02, so the author and the reviewer run the gates by hand on the head
commit:

```bash
pnpm fmt:check
pnpm lint
pnpm knip:check
pnpm typecheck
vp test run <changed test files>
pnpm test
```

`pnpm test` runs every package's suite. It is slow, and it is required before every PR. Failures
that also happen on the base commit are recorded in the ticket with the base SHA, not ignored, and
the developer decides whether they block ([AGENTS.md](../../AGENTS.md#when-to-stop-and-ask)).
