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

| Tier            | What                                                                                                                                                                                                              | Tool and location                                                                                                                             | Run with                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1. Unit         | Pure logic: parsing, reducers, schema decoding, edit-document operations                                                                                                                                          | Vitest via Vite+ (`*.test.ts` next to the code); pytest for the engine once it exists                                                         | `vp test run <files>`           |
| 2. Edge cases   | The failure paths the ticket names: empty, huge, odd frame rates, variable frame rate, silent or missing audio, offline, missing model, bad or revoked key, cancel mid-way, disk full, old documents and settings | Same files as Tier 1, in their own `describe`                                                                                                 | `vp test run <files>`           |
| 3. End to end   | A full user flow in the desktop app                                                                                                                                                                               | Playwright driving Electron (`playwright-core`, already a desktop dependency). The `e2e/` harness arrives with the first ticket that needs it | `pnpm e2e -- <spec>` once added |
| 4. Golden media | A fixed input clip through the real pipeline, compared with a stored reference                                                                                                                                    | `pnpm test:golden`, added with the first ticket marked `Touches media: yes`                                                                   | `pnpm test:golden -- <case>`    |
| UX screenshots  | Every changed screen in dark and light themes at `1440x900` and the minimum `1180x760`                                                                                                                            | Playwright, attached to the PR (not committed)                                                                                                | per ticket                      |

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

- Only clips we shot ourselves or CC0 clips, each listed with its source and licence in the fixture
  folder's `SOURCES.md`.
- **Never client footage or audio** (KigaruTalks, Charger, Spicy Food or any other client), CapCut
  library sounds or effects, or anyone else's media, even for a quick local test that "won't be
  committed".
- Keep fixtures small: a few seconds, low resolution unless the test is about resolution.
- Model weights are never fixtures. Tests that need a model use a stub, or skip with a clear reason
  when the model is not downloaded.

## Providers and cost

Real agent turns cost money. Use the free `Replay (dev)` provider that `pnpm dev` registers to stream
recorded turns through the pipeline and UI; see the
[test-t3-app skill](../../.agents/skills/test-t3-app/SKILL.md). Use a real provider only when the
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
```

`pnpm test` runs every package's suite and is slow; run it when a ticket's ACs ask for it. Failures
that also happen on the base commit are recorded in the ticket with the base SHA, not ignored.
